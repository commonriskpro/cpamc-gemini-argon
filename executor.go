package main

import (
	"bytes"
	"context"
	"crypto/rand"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"time"
)

const geminiTimeout = 120 * time.Second

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

func resolveGeminiRunnerPath() string {
	if p := os.Getenv("GEMINI_RUNNER_PATH"); p != "" {
		if _, err := os.Stat(p); err == nil {
			return p
		}
	}
	if cur, err := os.Getwd(); err == nil {
		for _, rel := range []string{"gemini_runner.js", "cpamc-gemini-argon/gemini_runner.js"} {
			candidate := filepath.Join(cur, rel)
			if _, err := os.Stat(candidate); err == nil {
				return candidate
			}
		}
	}
	if home, err := os.UserHomeDir(); err == nil {
		for _, sub := range []string{
			filepath.Join(".cli-proxy-api", "plugins", "gemini_runner.js"),
			filepath.Join(".cli-proxy-api", "plugins", "darwin", "arm64", "gemini_runner.js"),
			filepath.Join(".cli-proxy-api", "plugins", "linux", "amd64", "gemini_runner.js"),
			filepath.Join(".cli-proxy-api", "plugins", "linux", "arm64", "gemini_runner.js"),
		} {
			candidate := filepath.Join(home, sub)
			if _, err := os.Stat(candidate); err == nil {
				return candidate
			}
		}
	}
	return "/Users/saturno/Developer/cpamc-gemini-argon/gemini_runner.js"
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
	runnerPath := resolveGeminiRunnerPath()
	if _, err := os.Stat(runnerPath); err != nil {
		return nil, errors.New("gemini_runner.js not found: ensure gemini_runner.js is placed in CPAMC plugins directory")
	}
	nodeBin := resolveNodeBin()

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
