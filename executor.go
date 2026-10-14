package main

import (
	"bytes"
	"context"
	"crypto/rand"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"time"
)

const (
	geminiTimeout = 120 * time.Second
	daemonTimeout = 90 * time.Second
)

type chatMessage struct {
	Role       string          `json:"role"`
	Content    string          `json:"content"`
	ToolCalls  json.RawMessage `json:"tool_calls,omitempty"`
	ToolCallID string          `json:"tool_call_id,omitempty"`
}

type chatRequest struct {
	Model           string          `json:"model"`
	Messages        []chatMessage   `json:"messages"`
	Tools           json.RawMessage `json:"tools,omitempty"`
	Stream          bool            `json:"stream,omitempty"`
	ReasoningEffort string          `json:"reasoning_effort,omitempty"`
}

func validateRequest(body chatRequest, model string) error {
	m := strings.ToLower(strings.TrimSpace(model))
	if m != "gemini-4-argon" && m != "web-gemini/gemini-4-argon" && m != "gemini" && m != "argon" {
		return errors.New("unsupported model: only gemini-4-argon is supported")
	}
	return nil
}

func resolveScriptPath(name string) string {
	if p := os.Getenv("GEMINI_SCRIPT_PATH"); p != "" {
		if _, err := os.Stat(p); err == nil {
			return p
		}
	}
	if cur, err := os.Getwd(); err == nil {
		for _, rel := range []string{name, filepath.Join("cpamc-gemini-argon", name)} {
			candidate := filepath.Join(cur, rel)
			if _, err := os.Stat(candidate); err == nil {
				return candidate
			}
		}
	}
	if home, err := os.UserHomeDir(); err == nil {
		for _, sub := range []string{
			filepath.Join(".cli-proxy-api", "plugins", name),
			filepath.Join(".cli-proxy-api", "plugins", "darwin", "arm64", name),
			filepath.Join(".cli-proxy-api", "plugins", "linux", "amd64", name),
			filepath.Join(".cli-proxy-api", "plugins", "linux", "arm64", name),
		} {
			candidate := filepath.Join(home, sub)
			if _, err := os.Stat(candidate); err == nil {
				return candidate
			}
		}
	}
	return filepath.Join("/Users/saturno/Developer/cpamc-gemini-argon", name)
}

func resolveNodeBin() string {
	if bin, err := exec.LookPath("node"); err == nil {
		return bin
	}
	for _, candidate := range []string{"/usr/bin/node", "/usr/local/bin/node", "/opt/homebrew/bin/node"} {
		if _, err := os.Stat(candidate); err == nil {
			return candidate
		}
	}
	return "node"
}

func postDaemon(ctx context.Context, payload []byte) ([]byte, error) {
	port := os.Getenv("GEMINI_DAEMON_PORT")
	if port == "" {
		port = "8319"
	}
	url := fmt.Sprintf("http://127.0.0.1:%s/generate", port)
	req, err := http.NewRequestWithContext(ctx, "POST", url, bytes.NewReader(payload))
	if err != nil {
		return nil, err
	}
	req.Header.Set("Content-Type", "application/json")
	client := &http.Client{Timeout: daemonTimeout}
	resp, err := client.Do(req)
	if err != nil {
		return nil, err
	}
	defer resp.Body.Close()
	body, err := io.ReadAll(resp.Body)
	if err != nil {
		return nil, err
	}
	if resp.StatusCode != http.StatusOK {
		var errEnv map[string]any
		if json.Unmarshal(body, &errEnv) == nil {
			if errMsg, ok := errEnv["error"].(string); ok && errMsg != "" {
				return nil, errors.New("daemon error: " + errMsg)
			}
		}
		return nil, fmt.Errorf("daemon returned HTTP %d: %s", resp.StatusCode, string(body))
	}
	return body, nil
}

func ensureDaemonStarted() error {
	daemonPath := resolveScriptPath("gemini_daemon.js")
	if _, err := os.Stat(daemonPath); err != nil {
		return err
	}
	nodeBin := resolveNodeBin()
	cmd := exec.Command(nodeBin, daemonPath)
	cmd.Stdout = nil
	cmd.Stderr = nil
	return cmd.Start()
}

func runStandalone(ctx context.Context, inBytes []byte) ([]byte, error) {
	runnerPath := resolveScriptPath("gemini_runner.js")
	if _, err := os.Stat(runnerPath); err != nil {
		return nil, errors.New("gemini_runner.js not found in CPAMC plugins directory")
	}
	nodeBin := resolveNodeBin()
	cmd := exec.CommandContext(ctx, nodeBin, runnerPath)
	cmd.Stdin = bytes.NewReader(inBytes)
	var stdout, stderr bytes.Buffer
	cmd.Stdout = &stdout
	cmd.Stderr = &stderr

	if err := cmd.Run(); err != nil {
		errStr := strings.TrimSpace(stderr.String())
		if errStr == "" {
			errStr = err.Error()
		}
		return nil, fmt.Errorf("gemini runner error: %s", errStr)
	}

	outBytes := bytes.TrimSpace(stdout.Bytes())
	if len(outBytes) == 0 {
		return nil, errors.New("Gemini runner returned empty output")
	}
	var envelope map[string]any
	if json.Unmarshal(outBytes, &envelope) != nil {
		return nil, errors.New("Gemini runner returned invalid JSON")
	}
	if errMsg, isErr := envelope["error"].(string); isErr && errMsg != "" {
		return nil, errors.New("Gemini runner error: " + errMsg)
	}
	return outBytes, nil
}

func execute(ctx context.Context, req executorRequest, isStream bool) (executorResponse, error) {
	credential, err := readCookieCredential(req.StorageJSON)
	if err != nil {
		return executorResponse{}, err
	}
	var body chatRequest
	if err := json.Unmarshal(req.Payload, &body); err != nil {
		return executorResponse{}, errors.New("invalid chat request payload")
	}
	requestedModel := strings.TrimSpace(req.Model)
	if requestedModel == "" {
		requestedModel = body.Model
	}
	if err := validateRequest(body, requestedModel); err != nil {
		return executorResponse{}, err
	}
	payload, err := runGemini(ctx, credential, body, "gemini-4-argon", requestedModel)
	if err != nil {
		return executorResponse{}, err
	}
	return executorResponse{
		Payload: payload,
		Headers: map[string][]string{"Content-Type": {"application/json"}},
	}, nil
}

func runGemini(ctx context.Context, credential string, body chatRequest, upstreamModel, requestedModel string) ([]byte, error) {
	runnerInput := map[string]any{
		"model":          requestedModel,
		"upstream_model": upstreamModel,
		"messages":       body.Messages,
		"credential":     credential,
	}
	if len(body.Tools) > 0 && string(body.Tools) != "null" {
		var toolsParsed any
		if json.Unmarshal(body.Tools, &toolsParsed) == nil {
			runnerInput["tools"] = toolsParsed
		}
	}

	inBytes, err := json.Marshal(runnerInput)
	if err != nil {
		return nil, err
	}

	// 1. Try background daemon (warm headless instance)
	if outBytes, err := postDaemon(ctx, inBytes); err == nil && len(outBytes) > 0 {
		return outBytes, nil
	}

	// 2. If daemon not running, start it and retry once
	_ = ensureDaemonStarted()
	time.Sleep(600 * time.Millisecond)
	if outBytes, err := postDaemon(ctx, inBytes); err == nil && len(outBytes) > 0 {
		return outBytes, nil
	}

	// 3. Fallback: Standalone runner invocation
	return runStandalone(ctx, inBytes)
}

func geminiStreamChunks(payload []byte, model string) ([]streamChunk, error) {
	var resp struct {
		ID      string `json:"id"`
		Model   string `json:"model"`
		Choices []struct {
			Index   int `json:"index"`
			Message struct {
				Role      string          `json:"role"`
				Content   *string         `json:"content"`
				ToolCalls json.RawMessage `json:"tool_calls"`
			} `json:"message"`
			FinishReason string `json:"finish_reason"`
		} `json:"choices"`
	}
	if err := json.Unmarshal(payload, &resp); err != nil || len(resp.Choices) == 0 {
		return nil, errors.New("invalid Gemini response payload")
	}
	choice := resp.Choices[0]
	chunkID := resp.ID
	if chunkID == "" {
		chunkID = "chatcmpl-gw-" + randomUUID()[:12]
	}
	roleDelta := map[string]any{
		"id":      chunkID,
		"object":  "chat.completion.chunk",
		"created": time.Now().Unix(),
		"model":   model,
		"choices": []map[string]any{
			{
				"index":         0,
				"delta":         map[string]any{"role": "assistant"},
				"finish_reason": nil,
			},
		},
	}
	r1, _ := json.Marshal(roleDelta)
	contentDelta := map[string]any{
		"id":      chunkID,
		"object":  "chat.completion.chunk",
		"created": time.Now().Unix(),
		"model":   model,
		"choices": []map[string]any{
			{
				"index": 0,
				"delta": func() map[string]any {
					d := make(map[string]any)
					if choice.Message.Content != nil {
						d["content"] = *choice.Message.Content
					}
					if len(choice.Message.ToolCalls) > 0 && string(choice.Message.ToolCalls) != "null" {
						d["tool_calls"] = choice.Message.ToolCalls
					}
					return d
				}(),
				"finish_reason": nil,
			},
		},
	}
	r2, _ := json.Marshal(contentDelta)
	finishDelta := map[string]any{
		"id":      chunkID,
		"object":  "chat.completion.chunk",
		"created": time.Now().Unix(),
		"model":   model,
		"choices": []map[string]any{
			{
				"index":         0,
				"delta":         map[string]any{},
				"finish_reason": choice.FinishReason,
			},
		},
	}
	r3, _ := json.Marshal(finishDelta)
	return []streamChunk{
		{Payload: r1},
		{Payload: r2},
		{Payload: r3},
		{Payload: []byte("[DONE]")},
	}, nil
}

func randomUUID() string {
	b := make([]byte, 16)
	_, _ = rand.Read(b)
	return fmt.Sprintf("%x-%x-%x-%x-%x", b[0:4], b[4:6], b[6:8], b[8:10], b[10:16])
}
