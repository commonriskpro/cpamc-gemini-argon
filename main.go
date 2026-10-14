package main

/*
#cgo linux LDFLAGS: -ldl
#cgo linux CFLAGS: -D_GNU_SOURCE
#cgo windows LDFLAGS: -lkernel32
#if defined(__unix__) || defined(__APPLE__)
#ifndef _GNU_SOURCE
#define _GNU_SOURCE
#endif
#endif
#include <stdint.h>
#include <stdlib.h>

#if defined(__unix__) || defined(__APPLE__)
#include <dlfcn.h>
#include <pthread.h>
#elif defined(_WIN32) || defined(__CYGWIN__)
#include <windows.h>
#endif

typedef struct { void* ptr; size_t len; } cliproxy_buffer;
typedef int (*cliproxy_host_call_fn)(void*, const char*, const uint8_t*, size_t, cliproxy_buffer*);
typedef void (*cliproxy_host_free_fn)(void*, size_t);
typedef struct {
  uint32_t abi_version;
  void* host_ctx;
  cliproxy_host_call_fn call;
  cliproxy_host_free_fn free_buffer;
} cliproxy_host_api;
typedef int (*cliproxy_plugin_call_fn)(char*, uint8_t*, size_t, cliproxy_buffer*);
typedef void (*cliproxy_plugin_free_fn)(void*, size_t);
typedef void (*cliproxy_plugin_shutdown_fn)(void);
typedef struct {
  uint32_t abi_version;
  cliproxy_plugin_call_fn call;
  cliproxy_plugin_free_fn free_buffer;
  cliproxy_plugin_shutdown_fn shutdown;
} cliproxy_plugin_api;

static const cliproxy_host_api* stored_host;
static void store_host(const cliproxy_host_api* host) { stored_host = host; }
static int call_host(const char* method, const uint8_t* request, size_t request_len, cliproxy_buffer* response) {
  if (stored_host == NULL || stored_host->call == NULL) return 1;
  return stored_host->call(stored_host->host_ctx, method, request, request_len, response);
}
static void free_host(void* ptr, size_t len) {
  if (stored_host != NULL && stored_host->free_buffer != NULL && ptr != NULL) stored_host->free_buffer(ptr, len);
}

extern int cliproxy_plugin_init(cliproxy_host_api*, cliproxy_plugin_api*);
#if defined(__unix__) || defined(__APPLE__)
static pthread_mutex_t plugin_image_pin_mu = PTHREAD_MUTEX_INITIALIZER;
static void* plugin_image_pin;
static int pin_plugin_image(void) {
  int result = 0;
  pthread_mutex_lock(&plugin_image_pin_mu);
  if (plugin_image_pin == NULL) {
    Dl_info info;
    if (dladdr((void*)(uintptr_t)&cliproxy_plugin_init, &info) == 0 || info.dli_fname == NULL) {
      result = 1;
    } else {
      plugin_image_pin = dlopen(info.dli_fname, RTLD_NOW | RTLD_LOCAL);
      if (plugin_image_pin == NULL) result = 1;
    }
  }
  pthread_mutex_unlock(&plugin_image_pin_mu);
  return result;
}
#elif defined(_WIN32) || defined(__CYGWIN__)
static int pin_plugin_image(void) {
  HMODULE hModule = NULL;
  BOOL ok = GetModuleHandleExW(
    GET_MODULE_HANDLE_EX_FLAG_PIN | GET_MODULE_HANDLE_EX_FLAG_FROM_ADDRESS,
    (LPCWSTR)(uintptr_t)&cliproxy_plugin_init,
    &hModule
  );
  return ok ? 0 : 1;
}
#else
static int pin_plugin_image(void) { return 0; }
#endif

extern int cliproxyPluginCall(char*, uint8_t*, size_t, cliproxy_buffer*);
extern void cliproxyPluginFree(void*, size_t);
extern void cliproxyPluginShutdown(void);
*/
import "C"

import (
	"context"
	"crypto/sha256"
	"encoding/json"
	"errors"
	"fmt"
	"strings"
	"unsafe"
)

const (
	abiVersion    = 1
	schemaVersion = 6
	providerID    = "gemini-argon"
	maxRPCBytes   = 32 << 20
	upstreamRepo  = "https://github.com/commonriskpro/cpamc-gemini-argon"
)

const (
	methodRegister           = "plugin.register"
	methodReconfigure        = "plugin.reconfigure"
	methodPluginQuiesce      = "plugin.quiesce"
	methodManagementRegister = "management.register"
	methodManagementHandle   = "management.handle"
	methodModelStatic        = "model.static"
	methodModelForAuth       = "model.for_auth"
	methodAuthID             = "auth.identifier"
	methodAuthParse          = "auth.parse"
	methodAuthRefresh        = "auth.refresh"
	methodExecID             = "executor.identifier"
	methodExec               = "executor.execute"
	methodExecStream         = "executor.execute_stream"
)

type envelope struct {
	OK     bool            `json:"ok"`
	Result json.RawMessage `json:"result,omitempty"`
	Error  *rpcError       `json:"error,omitempty"`
}

type rpcError struct {
	Code       string `json:"code"`
	Message    string `json:"message"`
	HTTPStatus int    `json:"http_status,omitempty"`
	RetryAfter string `json:"retry_after,omitempty"`
}

type metadata struct {
	Name             string `json:"name"`
	Version          string `json:"version"`
	Author           string `json:"author"`
	Description      string `json:"description"`
	GitHubRepository string `json:"github_repository"`
}

type capabilities struct {
	ManagementAPI      bool     `json:"management_api"`
	ModelProvider      bool     `json:"model_provider"`
	AuthProvider       bool     `json:"auth_provider"`
	Executor           bool     `json:"executor"`
	ExecutorModelScope string   `json:"executor_model_scope"`
	ExecutorInput      []string `json:"executor_input"`
	ExecutorOutput     []string `json:"executor_output"`
}

type registration struct {
	SchemaVersion int          `json:"schema_version"`
	Metadata      metadata     `json:"metadata"`
	Capabilities  capabilities `json:"capabilities"`
}

type authData struct {
	Provider    string            `json:"Provider"`
	ID          string            `json:"ID"`
	FileName    string            `json:"FileName"`
	Label       string            `json:"Label"`
	Prefix      string            `json:"Prefix,omitempty"`
	ProxyURL    string            `json:"ProxyURL,omitempty"`
	Disabled    bool              `json:"Disabled,omitempty"`
	StorageJSON []byte            `json:"StorageJSON"`
	Metadata    map[string]any    `json:"Metadata,omitempty"`
	Attributes  map[string]string `json:"Attributes,omitempty"`
}

type authParseRequest struct {
	ID          string            `json:"ID"`
	FileName    string            `json:"FileName"`
	Label       string            `json:"Label"`
	Prefix      string            `json:"Prefix,omitempty"`
	ProxyURL    string            `json:"ProxyURL,omitempty"`
	Disabled    bool              `json:"Disabled,omitempty"`
	Provider    string            `json:"Provider"`
	Credential  string            `json:"Credential"`
	Metadata    map[string]any    `json:"Metadata,omitempty"`
	Attributes  map[string]string `json:"Attributes,omitempty"`
	StorageJSON []byte            `json:"StorageJSON,omitempty"`
}

type authParseResponse struct {
	Handled bool     `json:"Handled"`
	Auth    authData `json:"Auth,omitempty"`
}

type authRefreshRequest struct {
	AuthID       string            `json:"AuthID"`
	AuthProvider string            `json:"AuthProvider"`
	StorageJSON  []byte            `json:"StorageJSON"`
	Metadata     map[string]any    `json:"Metadata"`
	Attributes   map[string]string `json:"Attributes"`
	Prefix       string            `json:"Prefix,omitempty"`
	ProxyURL     string            `json:"ProxyURL,omitempty"`
	Disabled     bool              `json:"Disabled,omitempty"`
}

type authRefreshResponse struct {
	Auth authData `json:"Auth"`
}

type authModelRequest struct {
	AuthID       string            `json:"AuthID"`
	AuthProvider string            `json:"AuthProvider"`
	StorageJSON  []byte            `json:"StorageJSON"`
	Metadata     map[string]any    `json:"Metadata"`
	Attributes   map[string]string `json:"Attributes"`
}

type modelResponse struct {
	Provider string      `json:"Provider"`
	Models   []modelInfo `json:"Models"`
}

type modelInfo struct {
	ID                        string           `json:"ID"`
	Object                    string           `json:"Object"`
	Created                   int64            `json:"Created,omitempty"`
	OwnedBy                   string           `json:"OwnedBy"`
	Type                      string           `json:"Type,omitempty"`
	DisplayName               string           `json:"DisplayName"`
	Name                      string           `json:"Name"`
	Description               string           `json:"Description,omitempty"`
	ContextLength             int64            `json:"ContextLength,omitempty"`
	MaxCompletionTokens       int64            `json:"MaxCompletionTokens,omitempty"`
	SupportedParameters       []string         `json:"SupportedParameters,omitempty"`
	SupportedInputModalities  []string         `json:"SupportedInputModalities,omitempty"`
	SupportedOutputModalities []string         `json:"SupportedOutputModalities,omitempty"`
	Thinking                  *thinkingSupport `json:"Thinking,omitempty"`
}

type thinkingSupport struct {
	Min            int  `json:"Min"`
	Max            int  `json:"Max"`
	ZeroAllowed    bool `json:"ZeroAllowed"`
	DynamicAllowed bool `json:"DynamicAllowed"`
}

type executorRequest struct {
	AuthID         string              `json:"AuthID"`
	AuthProvider   string              `json:"AuthProvider"`
	Model          string              `json:"Model"`
	Format         string              `json:"Format"`
	Stream         bool                `json:"Stream"`
	Headers        map[string][]string `json:"Headers"`
	Payload        []byte              `json:"Payload"`
	StorageJSON    []byte              `json:"StorageJSON"`
	AuthMetadata   map[string]any      `json:"AuthMetadata"`
	AuthAttributes map[string]string   `json:"AuthAttributes"`
	StreamID       string              `json:"stream_id,omitempty"`
	HostCallbackID string              `json:"host_callback_id,omitempty"`
}

type executorResponse struct {
	Payload  []byte              `json:"Payload"`
	Headers  map[string][]string `json:"Headers,omitempty"`
	Metadata map[string]any      `json:"Metadata,omitempty"`
}

type executorStreamResponse struct {
	Headers map[string][]string `json:"Headers,omitempty"`
	Chunks  []streamChunk       `json:"Chunks,omitempty"`
}

type streamChunk struct {
	Payload []byte `json:"Payload,omitempty"`
	Error   string `json:"Error,omitempty"`
}

func main() {}

//export cliproxy_plugin_init
func cliproxy_plugin_init(host *C.cliproxy_host_api, plugin *C.cliproxy_plugin_api) C.int {
	if C.pin_plugin_image() != 0 {
		return 1
	}
	if host == nil || plugin == nil || uint32(host.abi_version) != abiVersion || host.call == nil || host.free_buffer == nil {
		return 1
	}
	if !beginPluginInit() {
		return 1
	}
	resetPluginLifecycle()
	C.store_host(host)
	plugin.abi_version = C.uint32_t(abiVersion)
	plugin.call = C.cliproxy_plugin_call_fn(C.cliproxyPluginCall)
	plugin.free_buffer = C.cliproxy_plugin_free_fn(C.cliproxyPluginFree)
	plugin.shutdown = C.cliproxy_plugin_shutdown_fn(C.cliproxyPluginShutdown)
	return 0
}

//export cliproxyPluginCall
func cliproxyPluginCall(method *C.char, request *C.uint8_t, requestLen C.size_t, response *C.cliproxy_buffer) C.int {
	if response != nil {
		response.ptr = nil
		response.len = 0
	}
	if method == nil {
		writeResponse(response, errorEnvelope("invalid_method", "method is required"))
		return 1
	}
	methodName := C.GoString(method)
	if !beginPluginCall(methodName) {
		writeResponse(response, errorEnvelope("plugin_quiesced", "plugin is quiescing"))
		return 1
	}
	defer endPluginCall()
	if uint64(requestLen) > uint64(maxRPCBytes) {
		writeResponse(response, errorEnvelope("request_too_large", "plugin request is too large"))
		return 1
	}
	var raw []byte
	if request != nil && requestLen > 0 {
		raw = C.GoBytes(unsafe.Pointer(request), C.int(requestLen))
	}
	result, err := handleMethod(methodName, raw)
	if err != nil {
		writeResponse(response, errorEnvelope("plugin_error", err.Error()))
		return 1
	}
	if !writeResponse(response, result) {
		return 1
	}
	return 0
}

//export cliproxyPluginFree
func cliproxyPluginFree(ptr unsafe.Pointer, _ C.size_t) {
	if ptr != nil {
		C.free(ptr)
	}
}

//export cliproxyPluginShutdown
func cliproxyPluginShutdown() {
	if !beginPluginShutdown() {
		return
	}
	shutdownPlugin()
	C.store_host(nil)
	finishPluginShutdown()
}

func handleMethod(method string, raw []byte) ([]byte, error) {
	switch method {
	case methodRegister, methodReconfigure:
		if method == methodReconfigure && !reopenPluginLifecycle() {
			return nil, errors.New("plugin is shutting down")
		}
		return okEnvelope(registration{
			SchemaVersion: schemaVersion,
			Metadata: metadata{
				Name:             "cpamc-gemini-argon",
				Version:          "1.0.0",
				Author:           "commonriskpro",
				Description:      "Gemini 4 Argon Web Plugin for CPAMC with autonomous synthetic tool calling",
				GitHubRepository: upstreamRepo,
			},
			Capabilities: capabilities{
				ManagementAPI:      true,
				ModelProvider:      true,
				AuthProvider:       true,
				Executor:           true,
				ExecutorModelScope: "all",
				ExecutorInput:      []string{"chat-completions"},
				ExecutorOutput:     []string{"chat-completions"},
			},
		})
	case methodPluginQuiesce:
		quiescePlugin()
		return okEnvelope(map[string]bool{"quiesced": true})
	case methodManagementRegister:
		return okEnvelope(resourceRegistration{
			Resources: []resourceRoute{
				{
					Path:        accountsResourcePath,
					Menu:        "Gemini 4 Argon",
					Description: "Connect Google Accounts with Gemini 4 Argon access",
				},
			},
		})
	case methodManagementHandle:
		var req resourceRequest
		if err := json.Unmarshal(raw, &req); err != nil {
			return nil, errors.New("invalid request")
		}
		return okEnvelope(serveAccountsResource(req))
	case methodModelStatic:
		return okEnvelope(modelResponse{
			Provider: providerID,
			Models:   defaultArgonModels(),
		})
	case methodModelForAuth:
		var req authModelRequest
		_ = json.Unmarshal(raw, &req)
		return okEnvelope(modelResponse{
			Provider: providerID,
			Models:   defaultArgonModels(),
		})
	case methodAuthID:
		return okEnvelope(map[string]string{"Identifier": providerID})
	case methodAuthParse:
		var req authParseRequest
		if err := json.Unmarshal(raw, &req); err != nil {
			return nil, errors.New("invalid request")
		}
		resp, err := parseAuth(req)
		if err != nil {
			return nil, err
		}
		return okEnvelope(resp)
	case methodAuthRefresh:
		var req authRefreshRequest
		if err := json.Unmarshal(raw, &req); err != nil {
			return nil, errors.New("invalid request")
		}
		if _, err := readCookieCredential(req.StorageJSON); err != nil {
			return nil, err
		}
		updated := makeAuthData(req.StorageJSON, req.AuthID, req.Attributes)
		updated.Prefix, updated.ProxyURL, updated.Disabled = req.Prefix, req.ProxyURL, req.Disabled
		return okEnvelope(authRefreshResponse{Auth: updated})
	case methodExecID:
		return okEnvelope(map[string]string{"Identifier": providerID})
	case methodExec:
		var req executorRequest
		if err := json.Unmarshal(raw, &req); err != nil {
			return nil, errors.New("invalid request")
		}
		ctx, cancel := context.WithTimeout(context.Background(), geminiTimeout)
		defer cancel()
		resp, err := execute(ctx, req, false)
		if err != nil {
			return nil, err
		}
		return okEnvelope(resp)
	case methodExecStream:
		var req executorRequest
		if err := json.Unmarshal(raw, &req); err != nil {
			return nil, errors.New("invalid request")
		}
		ctx, cancel := context.WithTimeout(context.Background(), geminiTimeout)
		defer cancel()
		resp, err := execute(ctx, req, true)
		if err != nil {
			return nil, err
		}
		publicModel := strings.TrimSpace(req.Model)
		if publicModel == "" {
			var body chatRequest
			if json.Unmarshal(req.Payload, &body) == nil {
				publicModel = body.Model
			}
		}
		chunks, err := geminiStreamChunks(resp.Payload, publicModel)
		if err != nil {
			return nil, err
		}
		return okEnvelope(executorStreamResponse{
			Headers: map[string][]string{
				"Content-Type":  {"text/event-stream"},
				"Cache-Control": {"no-cache"},
			},
			Chunks: chunks,
		})
	default:
		return errorEnvelope("unknown_method", "unknown method"), nil
	}
}

func defaultArgonModels() []modelInfo {
	return []modelInfo{
		model("web-gemini/gemini-4-argon", "gemini-4-argon", "Gemini 4 Argon (Web)", true),
		model("gemini-4-argon", "gemini-4-argon", "Gemini 4 Argon", true),
	}
}

func model(id, upstreamID, name string, reasoning bool) modelInfo {
	m := modelInfo{
		ID:                        id,
		Object:                    "model",
		OwnedBy:                   providerID,
		DisplayName:               name,
		Name:                      upstreamID,
		ContextLength:             128000,
		MaxCompletionTokens:       16384,
		SupportedParameters:       []string{"stream", "tools", "thinking", "reasoning_effort"},
		SupportedInputModalities:  []string{"text"},
		SupportedOutputModalities: []string{"text"},
	}
	if reasoning {
		m.Thinking = &thinkingSupport{Min: 0, Max: 32768, ZeroAllowed: true, DynamicAllowed: false}
	}
	return m
}

func parseAuth(req authParseRequest) (authParseResponse, error) {
	provider := strings.ToLower(req.Provider)
	if provider != "" && provider != providerID && provider != "gemini" && provider != "web-gemini" && provider != "web-accounts" {
		return authParseResponse{Handled: false}, nil
	}
	storage := req.StorageJSON
	var err error
	if len(storage) == 0 {
		storage, err = storageForCredential(req.Credential)
		if err != nil {
			return authParseResponse{}, err
		}
	}
	if _, err := readCookieCredential(storage); err != nil {
		return authParseResponse{}, err
	}
	auth := makeAuthData(storage, req.ID, req.Attributes)
	if req.Label != "" {
		auth.Label = req.Label
	}
	auth.Prefix, auth.ProxyURL, auth.Disabled = req.Prefix, req.ProxyURL, req.Disabled
	return authParseResponse{Handled: true, Auth: auth}, nil
}

func storageForCredential(credential string) ([]byte, error) {
	c := strings.TrimSpace(credential)
	if c == "" {
		return nil, errors.New("Google session cookies are required")
	}
	data := map[string]string{
		"web_provider": "gemini",
		"cookie":       c,
	}
	return json.Marshal(data)
}

func makeAuthData(storage []byte, id string, attrs map[string]string) authData {
	if id == "" {
		sum := sha256.Sum256(storage)
		id = providerID + "-" + fmt.Sprintf("%x", sum[:8])
	}
	file := id + ".json"
	return authData{
		Provider:    providerID,
		ID:          id,
		FileName:    file,
		Label:       "Gemini 4 Argon account",
		StorageJSON: storage,
		Metadata:    map[string]any{"web_provider": "gemini"},
		Attributes:  attrs,
	}
}

func readCookieCredential(storage []byte) (string, error) {
	var data map[string]any
	if len(storage) == 0 || json.Unmarshal(storage, &data) != nil {
		return "", errors.New("invalid storage payload")
	}
	val, ok := data["cookie"].(string)
	if !ok || strings.TrimSpace(val) == "" {
		return "", errors.New("session cookies are missing in credential")
	}
	return val, nil
}

func okEnvelope(value any) ([]byte, error) {
	b, err := json.Marshal(value)
	if err != nil {
		return nil, err
	}
	return json.Marshal(envelope{OK: true, Result: b})
}

func errorEnvelope(code, message string) []byte {
	b, _ := json.Marshal(envelope{OK: false, Error: &rpcError{Code: code, Message: message}})
	return b
}

func writeResponse(response *C.cliproxy_buffer, raw []byte) bool {
	if response == nil || len(raw) == 0 || len(raw) > maxRPCBytes {
		return false
	}
	ptr := C.CBytes(raw)
	if ptr == nil {
		return false
	}
	response.ptr = ptr
	response.len = C.size_t(len(raw))
	return true
}
