package service

import (
	"github.com/QuantumNous/new-api/common"
	"github.com/QuantumNous/new-api/model"
	pluginruntime "github.com/QuantumNous/new-api/pkg/jsplugin"
	"github.com/QuantumNous/new-api/pkg/modelconfig"
	"github.com/gin-gonic/gin"
)

// TaskExecutionSnapshotFromContext captures immutable request and plugin
// provenance at submission time. It never copies plugin source or payloads.
func TaskExecutionSnapshotFromContext(ctx *gin.Context) *model.TaskExecutionSnapshot {
	if ctx == nil {
		return nil
	}
	snapshot := &model.TaskExecutionSnapshot{
		RequestID:                         ctx.GetString(common.RequestIdKey),
		ChannelModelConfigurationRevision: ctx.GetInt64(modelconfig.ContextKeyRevision),
	}
	if ctx.Request != nil && ctx.Request.URL != nil {
		snapshot.RequestPath = ctx.Request.URL.Path
	}

	pinnedValue, exists := ctx.Get(pluginruntime.ContextKeyPinnedPlugin)
	if exists {
		pinned, ok := pinnedValue.(pluginruntime.PinnedPlugin)
		if ok && pinned.Plugin != nil {
			generation := uint64(0)
			if pinned.Generation != nil {
				generation = pinned.Generation.Number
			}
			meta := pinned.Plugin.Meta
			snapshot.TaskPlugin = &model.TaskPluginSnapshot{
				Key:          meta.Key,
				SourceSHA256: pinned.Plugin.SourceSHA256,
				Name:         meta.Name,
				Version:      meta.Version,
				Author: &model.TaskPluginAuthorSnapshot{
					Name: meta.Author.Name,
					URL:  meta.Author.URL,
				},
				APIVersion: meta.APIVersion,
				Generation: generation,
			}
		}
	}

	if snapshot.RequestID == "" && snapshot.RequestPath == "" && snapshot.TaskPlugin == nil {
		return nil
	}
	return snapshot
}

// AppendTaskPluginAuditInfo writes role-separated, credential-free plugin
// provenance into a usage log.
func AppendTaskPluginAuditInfo(other *model.LogOther, snapshot *model.TaskPluginSnapshot) {
	if other == nil || snapshot == nil || snapshot.Key == "" {
		return
	}
	taskPlugin := map[string]any{
		"key":     snapshot.Key,
		"name":    snapshot.Name,
		"version": snapshot.Version,
	}
	if snapshot.Author != nil && snapshot.Author.Name != "" {
		author := map[string]any{"name": snapshot.Author.Name}
		if snapshot.Author.URL != "" {
			author["url"] = snapshot.Author.URL
		}
		taskPlugin["author"] = author
	}
	other.SetAdmin("task_plugin", taskPlugin)
	other.SetRoot("task_plugin", map[string]any{
		"key":           snapshot.Key,
		"version":       snapshot.Version,
		"api_version":   snapshot.APIVersion,
		"generation":    snapshot.Generation,
		"source_sha256": snapshot.SourceSHA256,
	})
}

// AppendTaskPluginContextAuditInfo is used before a task row exists, such as
// an upstream submission error log.
func AppendTaskPluginContextAuditInfo(ctx *gin.Context, other *model.LogOther) {
	execution := TaskExecutionSnapshotFromContext(ctx)
	if execution == nil {
		return
	}

	AppendTaskPluginAuditInfo(other, execution.TaskPlugin)
	if execution.ChannelModelConfigurationRevision > 0 {
		other.SetRoot("channel_model_configuration_revision", execution.ChannelModelConfigurationRevision)
	}
	if ctx.GetBool(modelconfig.ContextKeyUpstreamAttempted) {
		value, _ := ctx.Get(modelconfig.ContextKeyUpstreamCost)
		if cost, ok := value.(*modelconfig.CostSnapshot); ok && cost != nil {
			// An uncertain upstream failure is not a zero provider bill. Copy the
			// estimate into the existing root-only error audit without another debit.
			pending := *cost
			_ = modelconfig.SettleUpstreamCost(&pending, nil, false)
			other.SetRoot("upstream_cost", &pending)
		}
	}
}
