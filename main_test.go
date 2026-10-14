package main

import (
	"encoding/json"
	"testing"
)

func TestValidateRequest(t *testing.T) {
	cases := []struct {
		model string
		ok    bool
	}{
		{"gemini-4-argon", true},
		{"web-gemini/gemini-4-argon", true},
		{"gemini", true},
		{"argon", true},
		{"claude-3-5", false},
		{"gpt-4o", false},
	}
	for _, c := range cases {
		err := validateRequest(chatRequest{Model: c.model}, c.model)
		if c.ok && err != nil {
			t.Errorf("expected model %s to be valid, got: %v", c.model, err)
		}
		if !c.ok && err == nil {
			t.Errorf("expected model %s to fail validation", c.model)
		}
	}
}

func TestCookieCredentials(t *testing.T) {
	storage, err := storageForCredential("SID=test_cookie; __Secure-1PSID=test_1psid")
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	cookie, err := readCookieCredential(storage)
	if err != nil {
		t.Fatalf("unexpected read error: %v", err)
	}
	if cookie != "SID=test_cookie; __Secure-1PSID=test_1psid" {
		t.Errorf("unexpected cookie value: %s", cookie)
	}

	_, err = storageForCredential("")
	if err == nil {
		t.Error("expected error for empty credential")
	}
}

func TestDefaultArgonModels(t *testing.T) {
	models := defaultArgonModels()
	if len(models) == 0 {
		t.Fatal("expected at least one argon model")
	}
	found := false
	for _, m := range models {
		if m.ID == "gemini-4-argon" || m.ID == "web-gemini/gemini-4-argon" {
			found = true
			if m.Thinking == nil {
				t.Errorf("model %s expected thinking support enabled", m.ID)
			}
		}
	}
	if !found {
		t.Error("expected gemini-4-argon in default models")
	}
}

func TestGeminiStreamChunks(t *testing.T) {
	sample := map[string]any{
		"id": "chatcmpl-test-123",
		"model": "gemini-4-argon",
		"choices": []map[string]any{
			{
				"index": 0,
				"message": map[string]any{
					"role": "assistant",
					"content": "Hello world from Argon",
				},
				"finish_reason": "stop",
			},
		},
	}
	payload, _ := json.Marshal(sample)
	chunks, err := geminiStreamChunks(payload, "gemini-4-argon")
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if len(chunks) != 4 {
		t.Fatalf("expected 4 chunks (role, content, finish, DONE), got: %d", len(chunks))
	}
	if string(chunks[3].Payload) != "[DONE]" {
		t.Errorf("expected last chunk to be [DONE], got: %s", string(chunks[3].Payload))
	}
}
