package model

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"github.com/QuantumNous/new-api/pkg/modelconfig"
	"gorm.io/gorm"
	"sort"
)

type ReviewedProviderTaskHistory struct {
	VersionOnlySnapshots    int            `json:"versionOnlySnapshots"`
	MissingSourceVersions   []string       `json:"missingSourceVersions"`
	SourceDigestConflicts   int            `json:"sourceDigestConflicts"`
	Tasks                   int            `json:"tasks"`
	MissingSnapshot         int            `json:"missingSnapshot"`
	MissingInflightSnapshot int            `json:"missingInflightSnapshot"`
	Versions                map[string]int `json:"versions"`
}

// Inventory returns counts and versions only, never task payloads or credentials.
func InventoryReviewedProviderTaskHistory(ctx context.Context, key string) (ReviewedProviderTaskHistory, error) {
	return reviewedProviderTaskHistory(DB.WithContext(ctx), key)
}
func reviewedProviderTaskHistory(db *gorm.DB, key string) (ReviewedProviderTaskHistory, error) {
	result := ReviewedProviderTaskHistory{Versions: map[string]int{}, MissingSourceVersions: []string{}}
	hashes := map[string]map[string]bool{}
	if !modelconfig.SupportedProvider(key) {
		return result, nil
	}
	var tasks []Task
	err := db.Select("id", "status", "private_data").Where("platform = ?", key).FindInBatches(&tasks, 100, func(tx *gorm.DB, _ int) error {
		for _, task := range tasks {
			result.Tasks++
			if task.PrivateData.Execution == nil || task.PrivateData.Execution.TaskPlugin == nil || task.PrivateData.Execution.TaskPlugin.Key != key || task.PrivateData.Execution.TaskPlugin.Version == "" {
				result.MissingSnapshot++
				if task.Status != TaskStatusSuccess && task.Status != TaskStatusFailure {
					result.MissingInflightSnapshot++
				}
				continue
			}
			result.Versions[task.PrivateData.Execution.TaskPlugin.Version]++
			snapshot := task.PrivateData.Execution.TaskPlugin
			if snapshot.SourceSHA256 == "" {
				result.VersionOnlySnapshots++
			}
			if snapshot.SourceSHA256 != "" {
				if hashes[snapshot.Version] == nil {
					hashes[snapshot.Version] = map[string]bool{}
				}
				hashes[snapshot.Version][snapshot.SourceSHA256] = true
			}

		}
		return nil
	}).Error
	if err != nil {
		return result, errors.New("could not inventory reviewed provider task history")
	}

	if len(result.Versions) > 0 {
		var records []TaskPlugin
		if err := db.Select("version", "source_hash", "source").Where(map[string]any{"key": key}).Find(&records).Error; err != nil {
			return result, errors.New("could not verify retained provider plugin versions")
		}
		available := map[string]string{}
		actualHashes := map[string]string{}
		for _, record := range records {
			available[record.Version] = record.SourceHash
			digest := sha256.Sum256([]byte(record.Source))
			actualHashes[record.Version] = hex.EncodeToString(digest[:])
		}
		for version := range result.Versions {
			hash := available[version]
			if len(hash) != 64 {
				result.MissingSourceVersions = append(result.MissingSourceVersions, version)
				continue
			}
			if actualHashes[version] != hash {
				result.SourceDigestConflicts++
				continue
			}
			for expected := range hashes[version] {
				if expected != hash {
					result.SourceDigestConflicts++
					break
				}
			}
		}
		sort.Strings(result.MissingSourceVersions)
	}
	return result, nil
}
func guardReviewedProviderVersionReplacement(tx *gorm.DB, key, _ string) error {
	if !modelconfig.SupportedProvider(key) {
		return nil
	}
	history, err := reviewedProviderTaskHistory(tx, key)
	if err != nil {
		return err
	}
	if history.MissingSnapshot > 0 {
		return errors.New("reviewed provider has historical tasks without a proven execution version; activation is blocked")
	}

	if len(history.MissingSourceVersions) > 0 || history.SourceDigestConflicts > 0 {
		return errors.New("retain and verify every referenced historical provider plugin source before activation")
	}
	return nil
}
