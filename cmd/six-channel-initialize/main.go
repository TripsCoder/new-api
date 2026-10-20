// six-channel-initialize is a deliberate maintenance command. It does not
// install plugins, migrate databases, load .env files, or read channel keys.
package main

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"flag"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"sort"
	"strings"

	"github.com/QuantumNous/new-api/common"
	"github.com/QuantumNous/new-api/model"
	"github.com/QuantumNous/new-api/pkg/modelconfig"
	"github.com/glebarez/sqlite"
	"gorm.io/driver/mysql"
	"gorm.io/driver/postgres"
	"gorm.io/gorm"
	"gorm.io/gorm/logger"
)

var providerKeys = []string{"paisio_media", "yuxibox_media", "xcmapi_media", "artbox_media", "lxmone_media", "zhangyuge_media"}

type receiptFile struct {
	Format       string                                        `json:"format"`
	OperationKey string                                        `json:"operationKey"`
	Receipts     []model.SixConfigurationInitializationReceipt `json:"receipts"`
}

func main() {
	if err := run(context.Background(), os.Args[1:], os.Stdout); err != nil {
		fmt.Fprintln(os.Stderr, err)
		os.Exit(1)
	}
}

func run(ctx context.Context, args []string, output io.Writer) error {
	flags := flag.NewFlagSet("six-channel-initialize", flag.ContinueOnError)
	flags.SetOutput(io.Discard)
	action := flags.String("action", "preview", "prepare, discover, preview, apply, or restore")
	sourceDir := flags.String("source-dir", "plugin-sources/media-providers/six-v2", "reviewed source artifact directory")
	draftsFile := flags.String("drafts", "", "reviewed actual-model drafts; defaults to the source artifact's empty draft")
	channelFile := flags.String("channels", "", "explicit provider-to-channel-ID JSON file")
	planFile := flags.String("plan", "", "reviewable six-channel plan JSON file")
	receiptPath := flags.String("receipt", "", "new receipt file for apply; existing receipt file for restore")
	database := flags.String("database", "", "sqlite, mysql, or postgres; DSN comes only from SIX_CHANNEL_INITIALIZATION_DSN")
	actorID := flags.Int("actor", 0, "existing active administrator ID for audit")
	if err := flags.Parse(args); err != nil {
		return errors.New("invalid maintenance command arguments")
	}
	writeJSON := func(value any) error {
		raw, err := common.Marshal(value)
		if err != nil {
			return err
		}
		_, err = fmt.Fprintln(output, string(raw))
		return err
	}
	if *action == "prepare" {
		if *channelFile == "" || *planFile == "" {
			return errors.New("prepare requires --channels and a new --plan file")
		}
		if *draftsFile == "" {
			*draftsFile = filepath.Join(*sourceDir, "initial-configurations.json")
		}
		plan, err := preparePlan(*sourceDir, *channelFile, *draftsFile)
		if err != nil {
			return err
		}
		raw, err := common.Marshal(plan)
		if err != nil {
			return err
		}
		if err = writeNewFile(*planFile, raw); err != nil {
			return err
		}
		return writeJSON(map[string]any{"status": "prepared-not-applied", "channels": len(plan), "preserveKeys": true})
	}
	if *action != "discover" && *action != "preview" && *action != "apply" && *action != "restore" {
		return errors.New("unknown maintenance action")
	}
	db, err := connectDatabase(*database, *action == "discover" || *action == "preview")
	if err != nil {
		return err
	}
	connection, err := db.DB()
	if err != nil {
		return errors.New("could not open initialization database")
	}
	defer connection.Close()
	previous := model.DB
	model.DB = db
	defer func() { model.DB = previous }()
	if *action == "discover" {
		var channels []model.Channel
		if err := db.Select("id", "type", "setting").Where("type = ?", 61).Find(&channels).Error; err != nil {
			return errors.New("could not discover reviewed provider channels")
		}
		ids := map[string][]int{}
		for _, key := range providerKeys {
			ids[key] = []int{}
		}
		for _, channel := range channels {
			var setting struct {
				Key string `json:"task_plugin_key"`
			}
			if channel.Setting != nil && common.Unmarshal([]byte(*channel.Setting), &setting) == nil && modelconfig.SupportedProvider(setting.Key) {
				ids[setting.Key] = append(ids[setting.Key], channel.Id)
			}
		}
		history := map[string]model.ReviewedProviderTaskHistory{}
		for _, key := range providerKeys {
			value, err := model.InventoryReviewedProviderTaskHistory(ctx, key)
			if err != nil {
				return err
			}
			history[key] = value
		}
		return writeJSON(map[string]any{"status": "read-only", "channels": ids, "history": history})
	}
	if !db.Migrator().HasTable(&model.ChannelModelConfiguration{}) || !db.Migrator().HasTable(&model.SixConfigurationInitializationRun{}) {
		return errors.New("initialization tables are missing; deploy the reviewed host migration separately before applying")
	}
	if *action == "restore" {
		if err := requireAdministrator(db, *actorID); err != nil {
			return err
		}
		var receipt receiptFile
		if err := readJSON(*receiptPath, &receipt); err != nil {
			return err
		}
		if receipt.Format != "six-provider-initialization-receipt/v1" {
			return errors.New("invalid initialization receipt format")
		}
		if err := model.RestoreSixConfigurationInitialization(ctx, *actorID, receipt.Receipts); err != nil {
			return err
		}
		return writeJSON(map[string]any{"status": "restored-or-already-restored", "preserveKeys": true})
	}
	var plan []model.SixConfigurationInitialization
	if err := readJSON(*planFile, &plan); err != nil {
		return err
	}
	preview, err := model.PreviewSixConfigurationInitialization(ctx, plan)
	if err != nil {
		return errors.New("could not preview initialization; verify schema, channel scope and history")
	}
	if *action == "preview" {
		return writeJSON(preview)
	}
	if err := requireAdministrator(db, *actorID); err != nil {
		return err
	}
	if len(preview.Blockers) > 0 {
		return errors.New("initialization is blocked; run preview and resolve its reported preconditions")
	}
	if *receiptPath == "" {
		return errors.New("apply requires a new --receipt file")
	}
	// Reserve a new local receipt before any database mutation. The same result
	// is also committed transactionally in the database for crash recovery.
	receiptOut, err := os.OpenFile(*receiptPath, os.O_CREATE|os.O_EXCL|os.O_WRONLY, 0600)
	if err != nil {
		return errors.New("receipt output must be a new writable file")
	}
	committed := false
	defer func() {
		_ = receiptOut.Close()
		if !committed {
			_ = os.Remove(*receiptPath)
		}
	}()
	receipts, err := model.ApplySixConfigurationInitialization(ctx, *actorID, plan)
	if err != nil {
		return err
	}
	committed = true
	raw, err := common.Marshal(receiptFile{Format: "six-provider-initialization-receipt/v1", OperationKey: preview.OperationKey, Receipts: receipts})
	if err != nil {
		return err
	}
	if _, err = receiptOut.Write(raw); err != nil {
		return errors.New("database operation applied; recover its receipt by repeating the exact plan with a new receipt path")
	}
	if err = receiptOut.Sync(); err != nil {
		return errors.New("database operation applied; receipt durability is unconfirmed, repeat the exact plan with a new receipt path")
	}
	return writeJSON(map[string]any{"status": "applied-or-already-applied", "operationKey": preview.OperationKey, "preserveKeys": true})
}

func requireAdministrator(db *gorm.DB, id int) error {
	var actor model.User
	if id <= 0 || db.Select("id", "role", "status").First(&actor, id).Error != nil || actor.Role < common.RoleAdminUser || actor.Status != common.UserStatusEnabled {
		return errors.New("an existing active administrator --actor is required")
	}
	return nil
}
func readJSON(path string, value any) error {
	if path == "" {
		return errors.New("a JSON file path is required")
	}
	file, err := os.Open(path)
	if err != nil {
		return errors.New("could not read the requested JSON file")
	}
	defer file.Close()
	raw, err := io.ReadAll(io.LimitReader(file, (8<<20)+1))
	if err != nil || len(raw) > 8<<20 || common.Unmarshal(raw, value) != nil {
		return errors.New("invalid or oversized maintenance JSON")
	}
	return nil
}
func writeNewFile(path string, raw []byte) error {
	file, err := os.OpenFile(path, os.O_WRONLY|os.O_CREATE|os.O_EXCL, 0600)
	if err != nil {
		return errors.New("output must be a new writable file")
	}
	defer file.Close()
	_, err = file.Write(raw)
	if err != nil {
		return errors.New("could not write the maintenance file")
	}
	return file.Sync()
}
func connectDatabase(kind string, readOnly bool) (*gorm.DB, error) {
	dsn := os.Getenv("SIX_CHANNEL_INITIALIZATION_DSN")
	if dsn == "" {
		return nil, errors.New("set the explicit SIX_CHANNEL_INITIALIZATION_DSN; no application environment file is loaded")
	}
	var driver gorm.Dialector
	switch kind {
	case "sqlite":
		// A maintenance preview must not silently create a new SQLite database.
		if strings.ContainsAny(dsn, "?\x00") || dsn == ":memory:" {
			return nil, errors.New("SQLite maintenance DSN must name an existing database file")
		}
		path, err := filepath.Abs(dsn)
		if err != nil {
			return nil, errors.New("invalid SQLite database path")
		}
		if info, err := os.Stat(path); err != nil || info.IsDir() {
			return nil, errors.New("SQLite database file does not exist")
		}
		mode := "rw"
		if readOnly {
			mode = "ro"
		}
		driver = sqlite.Open("file:" + filepath.ToSlash(path) + "?mode=" + mode)
	case "mysql":
		driver = mysql.Open(dsn)
	case "postgres":
		driver = postgres.Open(dsn)
	default:
		return nil, errors.New("choose --database sqlite, mysql, or postgres")
	}
	db, err := gorm.Open(driver, &gorm.Config{Logger: logger.Default.LogMode(logger.Silent)})
	if err != nil {
		return nil, errors.New("could not connect to the explicitly selected initialization database")
	}
	return db, nil
}
func preparePlan(root, channelPath, draftsPath string) ([]model.SixConfigurationInitialization, error) {
	var channels map[string]int
	if err := readJSON(channelPath, &channels); err != nil {
		return nil, err
	}
	var drafts struct {
		Configurations map[string]modelconfig.Document `json:"configurations"`
	}
	if err := readJSON(draftsPath, &drafts); err != nil {
		return nil, err
	}
	var manifest struct {
		Version string `json:"version"`
		Plugins []struct {
			Key     string `json:"key"`
			Version string `json:"version"`
			File    string `json:"file"`
			SHA256  string `json:"sha256"`
		} `json:"plugins"`
		Inputs map[string]string `json:"inputs"`
	}
	if err := readJSON(filepath.Join(root, "dist", "manifest.json"), &manifest); err != nil {
		return nil, err
	}
	if !modelconfig.ReviewedPluginVersion(manifest.Version) || len(manifest.Plugins) != 6 || len(drafts.Configurations) != 6 || len(channels) != 6 {
		return nil, errors.New("prepare requires exactly the six reviewed provider artifacts and channel IDs")
	}
	for name, expected := range manifest.Inputs {
		if filepath.Base(name) != name {
			return nil, errors.New("invalid build input path")
		}
		raw, err := os.ReadFile(filepath.Join(root, name))
		if err != nil {
			return nil, errors.New("missing reviewed build input")
		}
		hash := sha256.Sum256(raw)
		if hex.EncodeToString(hash[:]) != expected {
			return nil, errors.New("reviewed build input fingerprint changed")
		}
	}
	hashes := map[string]string{}
	for _, plugin := range manifest.Plugins {
		if !modelconfig.SupportedProvider(plugin.Key) || plugin.Version != manifest.Version || plugin.File != plugin.Key+".plugin.js" || hashes[plugin.Key] != "" {
			return nil, errors.New("invalid six-provider build manifest")
		}
		raw, err := os.ReadFile(filepath.Join(root, "dist", plugin.File))
		if err != nil {
			return nil, errors.New("missing reviewed plugin artifact")
		}
		hash := sha256.Sum256(raw)
		if hex.EncodeToString(hash[:]) != plugin.SHA256 {
			return nil, errors.New("reviewed plugin artifact fingerprint changed")
		}
		hashes[plugin.Key] = plugin.SHA256
	}
	plan := make([]model.SixConfigurationInitialization, 0, 6)
	for _, key := range providerKeys {
		if channels[key] <= 0 {
			return nil, fmt.Errorf("missing existing channel ID for %s; do not invent or replace its key", key)
		}
		document, ok := drafts.Configurations[key]
		if !ok || document.Provider != key {
			return nil, errors.New("draft provider does not match the manifest")
		}
		if err := modelconfig.Validate(document); err != nil {
			return nil, err
		}
		raw, err := common.Marshal(document)
		if err != nil {
			return nil, err
		}
		hash := sha256.Sum256(raw)
		plan = append(plan, model.SixConfigurationInitialization{ChannelID: channels[key], ExpectedRevision: 0, PluginSHA256: hashes[key], DocumentSHA256: hex.EncodeToString(hash[:]), Configuration: document})
	}
	sort.Slice(plan, func(i, j int) bool { return plan[i].ChannelID < plan[j].ChannelID })
	return plan, nil
}
