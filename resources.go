package main

import (
	_ "embed"
	"net/http"
)

const accountsResourcePath = "/v0/resource/plugins/gemini-argon/accounts"

//go:embed accounts.html
var accountsHTML []byte

type resourceRoute struct {
	Path        string
	Menu        string
	Description string
}

type resourceRegistration struct {
	Resources []resourceRoute `json:"resources"`
}

type resourceRequest struct {
	Method string
	Path   string
}

type resourceResponse struct {
	StatusCode int
	Headers    http.Header
	Body       []byte
}

func serveAccountsResource(req resourceRequest) resourceResponse {
	headers := http.Header{
		"Content-Type":            {"text/html; charset=utf-8"},
		"Cache-Control":           {"no-store"},
		"X-Content-Type-Options":  {"nosniff"},
		"Referrer-Policy":         {"no-referrer"},
		"Content-Security-Policy": {"default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'"},
	}
	if req.Path != accountsResourcePath {
		return resourceResponse{StatusCode: http.StatusNotFound, Headers: headers, Body: []byte("Not found")}
	}
	if req.Method != http.MethodGet {
		headers.Set("Allow", http.MethodGet)
		return resourceResponse{StatusCode: http.StatusMethodNotAllowed, Headers: headers, Body: []byte("Method not allowed")}
	}
	return resourceResponse{StatusCode: http.StatusOK, Headers: headers, Body: accountsHTML}
}

