package controller

import (
	"errors"
	"net/http"
	"strconv"
	"strings"

	"github.com/QuantumNous/new-api/common"
	"github.com/QuantumNous/new-api/model"
	"github.com/QuantumNous/new-api/pkg/jsplugin"
	"github.com/QuantumNous/new-api/pkg/modelconfig"
	"github.com/QuantumNous/new-api/plugins"
	"github.com/QuantumNous/new-api/service"
	"github.com/gin-gonic/gin"
	"gorm.io/gorm"
)

func modelConfigurationChannel(c *gin.Context) (*model.Channel, string, error) {
	id, err := strconv.Atoi(c.Param("id"))
	if err != nil || id <= 0 {
		return nil, "", errors.New("invalid channel id")
	}
	channel, err := model.GetChannelById(id, false)
	if err != nil {
		return nil, "", err
	}
	var setting struct {
		TaskPluginKey string `json:"task_plugin_key"`
	}
	if channel.Setting != nil {
		if err = common.Unmarshal([]byte(*channel.Setting), &setting); err != nil {
			return nil, "", errors.New("invalid channel settings")
		}
	}
	key := setting.TaskPluginKey
	if channel.Type != 61 || !modelconfig.SupportedProvider(key) {
		return nil, "", errors.New("model configuration is available only for the six reviewed providers")
	}
	return channel, key, nil
}
func GetChannelModelConfiguration(c *gin.Context) {
	channel, key, err := modelConfigurationChannel(c)
	if err != nil {
		common.ApiError(c, err)
		return
	}
	document, err := model.GetChannelModelConfiguration(c.Request.Context(), channel.Id, 0)
	if errors.Is(err, gorm.ErrRecordNotFound) {
		document = modelconfig.Empty(key)
	} else if err != nil {
		common.ApiError(c, err)
		return
	}
	versions, err := model.ListChannelModelConfigurationVersions(c.Request.Context(), channel.Id)
	if err != nil {
		common.ApiError(c, err)
		return
	}
	catalog, err := modelconfig.ProviderCatalog(key)
	if err != nil {
		common.ApiError(c, err)
		return
	}
	// Copy before projecting: the embedded compatibility catalog is immutable.
	raw, err := common.Marshal(catalog)
	if err != nil {
		common.ApiError(c, err)
		return
	}
	var projection map[string]any
	if err = common.Unmarshal(raw, &projection); err != nil {
		common.ApiError(c, err)
		return
	}
	delete(projection, "interfaces")
	pluginVersion := ""
	if installed, lookupErr := model.GetTaskPluginVersion(key, ""); lookupErr == nil {
		pluginVersion = installed.Version
		compiled, ok := jsplugin.DefaultRegistry.Generation().Get(key)
		if !ok || compiled.SourceSHA256 != installed.SourceHash || compiled.Meta.Version != installed.Version {
			var compileErr error
			compiled, compileErr = jsplugin.CompilePlugin(string(installed.Source), jsplugin.Options{Key: key})
			if compileErr != nil {
				common.ApiError(c, compileErr)
				return
			}
		}
		if len(compiled.Meta.ParameterInterfaces) > 0 {
			projection["interfaces"] = compiled.Meta.ParameterInterfaces
			projection["models"] = map[string]any{}
		}
	}
	catalog = projection
	common.ApiSuccess(c, gin.H{"configuration": document, "versions": versions, "catalog": catalog, "pluginVersion": pluginVersion, "channelModels": channel.Models})
}

type channelConfigurationSave struct {
	AddModels        []string             `json:"addModels"`
	RemoveModels     []string             `json:"removeModels"`
	ExpectedModels   string               `json:"expectedModels"`
	AddBoundModels   bool                 `json:"addBoundModels"`
	ExpectedRevision int64                `json:"expectedRevision"`
	Configuration    modelconfig.Document `json:"configuration"`
}

func SaveChannelModelConfiguration(c *gin.Context) {
	channel, key, err := modelConfigurationChannel(c)
	if err != nil {
		common.ApiError(c, err)
		return
	}
	c.Request.Body = http.MaxBytesReader(c.Writer, c.Request.Body, 1<<20)
	var request channelConfigurationSave
	if err = c.ShouldBindJSON(&request); err != nil {
		common.ApiErrorMsg(c, "Invalid model configuration JSON")
		return
	}
	if request.Configuration.Provider != key {
		common.ApiErrorMsg(c, "Configuration does not belong to this channel provider")
		return
	}
	var batch [][]string
	if request.AddModels != nil {
		batch = append(batch, request.AddModels)
	}
	applyRoutes := request.AddModels != nil || request.AddBoundModels
	result, err := model.SaveChannelModelConfigurationRoutes(c.Request.Context(), channel.Id, c.GetInt("id"), request.Configuration, request.ExpectedRevision, applyRoutes, request.RemoveModels, request.ExpectedModels, batch...)
	if errors.Is(err, model.ErrModelConfigurationConflict) {
		c.JSON(http.StatusConflict, gin.H{"success": false, "message": "Channel model configuration changed; reload before saving"})
		return
	}
	if err != nil {
		common.ApiError(c, err)
		return
	}
	if applyRoutes || len(request.RemoveModels) > 0 {
		model.InitChannelCache()
	}
	common.ApiSuccess(c, result)
}
func RestoreChannelModelConfiguration(c *gin.Context) {
	channel, key, err := modelConfigurationChannel(c)
	if err != nil {
		common.ApiError(c, err)
		return
	}
	var request struct {
		Revision         int64 `json:"revision"`
		ExpectedRevision int64 `json:"expectedRevision"`
	}
	if c.ShouldBindJSON(&request) != nil || request.Revision <= 0 {
		common.ApiErrorMsg(c, "Select a saved configuration version")
		return
	}
	document, err := model.GetChannelModelConfiguration(c.Request.Context(), channel.Id, request.Revision)
	if err != nil {
		common.ApiError(c, err)
		return
	}
	if document.Provider != key {
		common.ApiErrorMsg(c, "Configuration does not belong to this channel provider")
		return
	}
	result, err := model.SaveChannelModelConfiguration(c.Request.Context(), channel.Id, c.GetInt("id"), document, request.ExpectedRevision)
	if errors.Is(err, model.ErrModelConfigurationConflict) {
		c.JSON(http.StatusConflict, gin.H{"success": false, "message": "Channel model configuration changed; reload before saving"})
		return
	}
	if err != nil {
		common.ApiError(c, err)
		return
	}
	common.ApiSuccess(c, result)
}
func CheckChannelModelConfiguration(c *gin.Context) {
	channel, key, err := modelConfigurationChannel(c)
	if err != nil {
		common.ApiError(c, err)
		return
	}
	c.Request.Body = http.MaxBytesReader(c.Writer, c.Request.Body, 1<<20)
	var request struct {
		Configuration modelconfig.Document `json:"configuration"`
		Capabilities  bool                 `json:"capabilities"`
		Model         string               `json:"model"`
		Mode          string               `json:"mode"`
		Input         map[string]any       `json:"input"`
	}
	if c.ShouldBindJSON(&request) != nil {
		common.ApiError(c, modelConfigurationInputError(request.Model, errors.New("Invalid model configuration JSON")))
		return
	}
	if request.Configuration.Provider != key {
		common.ApiError(c, modelConfigurationInputError(request.Model, errors.New("Configuration does not belong to this channel provider")))
		return
	}
	request.Configuration, err = modelconfig.InputCheckDocument(request.Configuration, request.Model)
	if err != nil {
		common.ApiError(c, modelConfigurationInputError(request.Model, err))
		return
	}
	source := ""
	plugin, err := model.GetTaskPluginVersion(key, "")
	if err == nil {
		source = string(plugin.Source)
	} else if errors.Is(err, gorm.ErrRecordNotFound) {
		source, err = plugins.Source(key)
	}
	if err != nil {
		common.ApiError(c, modelConfigurationInputError(request.Model, errors.New("Task plugin is not installed")))
		return
	}
	loaded, err := jsplugin.NewRegistry().Register(source, jsplugin.Options{Key: key})
	if err != nil {
		common.ApiError(c, modelConfigurationInputError(request.Model, errors.New("Task plugin could not be loaded")))
		return
	}
	operation := "video_generate"
	if strings.HasSuffix(request.Mode, "image") {
		operation = "image_generate"
	}
	if request.Mode == "edit_image" {
		operation = "image_edit"
	}
	protocol := "openai_video"
	decodeOperation := "generate"
	if strings.HasSuffix(request.Mode, "image") {
		protocol = "openai_image"
	}
	if request.Mode == "edit_image" {
		decodeOperation = "edit"
	}
	// Match the actual final decoder before applying the channel overlay.
	decoded, err := loaded.Engine.CallPath(c.Request.Context(), "protocols", []string{protocol, "decodeRequest"}, map[string]any{
		"model": request.Model, "upstreamModel": request.Model, "operation": decodeOperation,
		"body": map[string]any{"kind": "json", "value": request.Input},
	})
	if err != nil {
		common.ApiError(c, modelConfigurationInputError(request.Model, err))
		return
	}
	wrapper, ok := decoded.(map[string]any)
	if !ok {
		common.ApiError(c, modelConfigurationInputError(request.Model, errors.New("Invalid task decoder result")))
		return
	}
	body, ok := wrapper["requestBody"].(map[string]any)
	if !ok {
		common.ApiError(c, modelConfigurationInputError(request.Model, errors.New("Invalid task decoder body")))
		return
	}
	original, ok := body["input"].(map[string]any)
	if !ok {
		common.ApiError(c, modelConfigurationInputError(request.Model, errors.New("Invalid decoded task input")))
		return
	}
	contractMode, _ := body["contractMode"].(string)
	input, definition, actualMode, unified, err := modelconfig.ResolveUnified(request.Configuration, request.Model, operation, original, false)
	if !unified && err == nil {
		actualMode, err = modelconfig.InferConfiguredMode(request.Configuration, request.Model, operation, original, body["uploads"], contractMode)
		if err == nil && actualMode != request.Mode && !request.Capabilities {
			err = errors.New("Input references do not match the selected generation mode")
		}
		if err == nil {
			input, definition, err = modelconfig.Resolve(request.Configuration, request.Model, actualMode, original)
		}
	}
	if err != nil {
		common.ApiError(c, modelConfigurationInputError(request.Model, err))
		return
	}
	if hint := modelconfig.ProtocolContractHint(request.Configuration.Provider, definition.Protocol); hint != "" {
		contractMode = hint
	}
	if !unified && modelconfig.InferContractMode(operation, input, body["uploads"], contractMode) != actualMode {
		common.ApiError(c, modelConfigurationInputError(request.Model, errors.New("Configuration changes the generation mode")))
		return
	}
	body["contractMode"] = contractMode
	body["input"] = input
	// As in the live relay, only the resolved configuration supplies policy.
	// Neither the sample JSON nor other model bindings can grant unrestricted values.
	delete(body, "unrestrictedValueFields")
	delete(body, "manualInterfaceFields")
	unrestricted := []string{}
	for field, parameter := range definition.Parameters {
		if modelconfig.UnrestrictedValueLimits(parameter) {
			unrestricted = append(unrestricted, field)
		}
	}
	if len(unrestricted) > 0 {
		body["unrestrictedValueFields"] = unrestricted
	}
	if definition.Protocol != nil {
		if !modelconfig.ReviewedPluginVersion(loaded.Meta.Version) {
			common.ApiError(c, modelConfigurationInputError(request.Model, common.NewMessage("Model {{model}} / field {{field}}: plugin version {{version}} is not supported by this host; update the host and plugin to compatible versions", map[string]any{"model": request.Model, "field": "plugin_version", "version": loaded.Meta.Version})))
			return
		}
		body["protocolTemplate"] = definition.Protocol.TemplateModel
		if fields := modelconfig.ManualInterfaceFields(definition.Protocol); len(fields) > 0 {
			body["manualInterfaceFields"] = fields
		}
	}
	// No WithFetcher is installed: hooks cannot send network requests. Real
	// credentials are neither read from the channel nor included in results.
	ctx := map[string]any{"model": request.Model, "upstreamModel": request.Model, "baseUrl": channel.GetBaseURL(), "apiKey": "configuration-check-placeholder", "publicTaskId": "task_configuration_check_0001", "requestBody": body, "files": body["uploads"]}
	var output map[string]any
	err = loaded.Engine.CallInto(c.Request.Context(), &output, "buildSubmitRequest", ctx)
	if err != nil {
		common.ApiError(c, modelConfigurationInputError(request.Model, err))
		return
	}
	delete(output, "headers")
	delete(output, "credentialless")
	mapping := map[string]string{}
	for field, target := range definition.Mapping {
		mapping[field] = target
	}
	if b, ok := request.Configuration.Bindings[request.Model][actualMode]; ok {
		for field, target := range b.Mapping {
			mapping[field] = target
		}
	}
	explicitTargets := map[string]bool{}
	for field := range original {
		target := field
		if mapped, ok := mapping[field]; ok {
			target = mapped
		}
		explicitTargets[target] = true
	}
	defaultsAdded := map[string]any{}
	for field, value := range input {
		if !explicitTargets[field] {
			defaultsAdded[field] = value
		}
	}
	ignored := []string{}
	for field := range original {
		if mapping[field] == "@ignore" {
			ignored = append(ignored, field)
		}
	}
	common.ApiSuccess(c, gin.H{"kind": "input_check", "actualCall": false, "message": "Input checked; no request was sent", "request": output, "actualMode": actualMode, "resolvedInput": input, "defaultsAdded": defaultsAdded, "ignoredFields": ignored})
}

func GetChannelModelConfigurationAvailability(c *gin.Context) {
	_, key, err := modelConfigurationChannel(c)
	if err != nil {
		common.ApiError(c, err)
		return
	}
	common.ApiSuccess(c, service.GetReviewedProviderAvailability(c.Request.Context(), key))
}
