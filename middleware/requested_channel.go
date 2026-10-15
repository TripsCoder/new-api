package middleware

import (
	"net/http"

	"github.com/QuantumNous/new-api/common"
	"github.com/QuantumNous/new-api/constant"
	"github.com/QuantumNous/new-api/dto"
	"github.com/QuantumNous/new-api/i18n"
	"github.com/QuantumNous/new-api/model"
	"github.com/QuantumNous/new-api/pkg/jsplugin"
	"github.com/QuantumNous/new-api/service"
	"github.com/gin-gonic/gin"
)

// Preflight uses the same authorization and frozen group as final distribution,
// but does not load a provider key or execute a provider-specific decoder.
func selectRequestedChannelForModel(c *gin.Context, modelName string) (*model.Channel, bool) {
	constraints := service.GetChannelConstraints(c)
	if constraints.RequestedChannelID == 0 {
		return nil, true
	}
	constraints.AddFilter(dto.ChannelFilter{Kind: dto.FilterRequestPath, RequestPath: c.Request.URL.Path})
	channel, _, selectErr := service.SelectChannelForRequest(c, modelName, &service.RetryParam{
		Ctx: c, ModelName: modelName, TokenGroup: common.GetContextKeyString(c, constant.ContextKeyUsingGroup),
	})
	if selectErr != nil {
		message := selectErr.Message
		if selectErr.MessageID != "" {
			message = i18n.T(c, selectErr.MessageID, selectErr.Params)
		}
		abortWithOpenAiMessage(c, selectErr.StatusCode, message, selectErr.Code)
		return nil, false
	}
	return channel, true
}

// Plugin-owned routes may nest or default their model. Check channel ownership
// before decoding; final distribution checks the decoded model and native token.
func requestedChannelOwnsPlugin(c *gin.Context, generation *jsplugin.RoutingGeneration, plugin *jsplugin.LoadedPlugin) bool {
	id := service.GetChannelConstraints(c).RequestedChannelID
	if id == 0 {
		return true
	}
	channel, err := model.CacheGetChannel(id)
	if err != nil || channel == nil || channel.Status != common.ChannelStatusEnabled || !channelOwnsPlugin(channel, generation, plugin) {
		abortWithOpenAiMessage(c, http.StatusForbidden, i18n.T(c, i18n.MsgRequestedChannelPluginUnsupported))
		return false
	}
	return true
}

func channelOwnsPlugin(channel *model.Channel, generation *jsplugin.RoutingGeneration, plugin *jsplugin.LoadedPlugin) bool {
	if channel == nil || plugin == nil {
		return false
	}
	if channel.Type == constant.ChannelTypeTaskPlugin || channel.Type == constant.ChannelTypeNewAPI {
		return channel.GetSetting().BindsTaskPlugin(plugin.Meta.Key)
	}
	if generation == nil {
		return false
	}
	owned, ok := generation.GetByChannelType(channel.Type)
	return ok && owned == plugin
}
