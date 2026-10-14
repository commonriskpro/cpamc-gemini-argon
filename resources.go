package main

import (
	_ "embed"
	"encoding/json"
	"fmt"
	"net/http"
	"os"
	"path/filepath"
	"sort"
	"strings"
)

const (
	accountsResourcePathLegacy = "/v0/resource/plugins/gemini-argon/accounts"
	accountsResourcePath       = "/v0/resource/plugins/cpamc-gemini-argon/accounts"
)

//go:embed accounts.html
var accountsTemplateHTML []byte

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

type accountStatusEntry struct {
	Email       string `json:"email"`
	AuthUser    int    `json:"authuser"`
	Status      string `json:"status"`
	ResetTime   string `json:"reset_time"`
	LastChecked int64  `json:"last_checked"`
}

type argonStatusFile struct {
	Accounts    map[string]accountStatusEntry `json:"accounts"`
	LastUpdated int64                         `json:"last_updated"`
}

type accountInfoItem struct {
	Email     string
	AuthUser  int
	Label     string
	Status    string
	ResetTime string
}

func serveAccountsResource(req resourceRequest) resourceResponse {
	headers := http.Header{
		"Content-Type":            {"text/html; charset=utf-8"},
		"Cache-Control":           {"no-store"},
		"X-Content-Type-Options":  {"nosniff"},
		"Referrer-Policy":         {"no-referrer"},
		"Content-Security-Policy": {"default-src 'self' 'unsafe-inline'; style-src 'unsafe-inline'; base-uri 'none'; form-action 'self'"},
	}

	p := strings.TrimRight(strings.TrimSpace(req.Path), "/")
	if !strings.HasSuffix(p, "/accounts") {
		return resourceResponse{StatusCode: http.StatusNotFound, Headers: headers, Body: []byte("Not found")}
	}
	if req.Method != http.MethodGet {
		headers.Set("Allow", http.MethodGet)
		return resourceResponse{StatusCode: http.StatusMethodNotAllowed, Headers: headers, Body: []byte("Method not allowed")}
	}

	htmlContent := renderAccountsDashboard()
	return resourceResponse{StatusCode: http.StatusOK, Headers: headers, Body: []byte(htmlContent)}
}

func renderAccountsDashboard() string {
	home, err := os.UserHomeDir()
	if err != nil {
		return string(accountsTemplateHTML)
	}

	authDir := filepath.Join(home, ".cli-proxy-api", "auths")
	statusPath := filepath.Join(home, ".cli-proxy-api", "gemini_argon_status.json")

	var statusData argonStatusFile
	if raw, err := os.ReadFile(statusPath); err == nil {
		_ = json.Unmarshal(raw, &statusData)
	}
	if statusData.Accounts == nil {
		statusData.Accounts = make(map[string]accountStatusEntry)
	}

	var items []accountInfoItem
	files, _ := os.ReadDir(authDir)
	for _, f := range files {
		if strings.HasPrefix(f.Name(), "gemini-argon-") && strings.HasSuffix(f.Name(), ".json") {
			fullPath := filepath.Join(authDir, f.Name())
			raw, err := os.ReadFile(fullPath)
			if err != nil {
				continue
			}
			var authMap map[string]any
			if json.Unmarshal(raw, &authMap) != nil {
				continue
			}
			email, _ := authMap["email"].(string)
			if email == "" {
				email = strings.TrimSuffix(strings.TrimPrefix(f.Name(), "gemini-argon-"), ".json")
			}
			var authUser int
			if u, ok := authMap["authuser"].(float64); ok {
				authUser = int(u)
			}
			label, _ := authMap["label"].(string)

			st, ok := statusData.Accounts[email]
			status := "active"
			resetTime := ""
			if ok && st.Status == "rate_limited" {
				status = "rate_limited"
				resetTime = st.ResetTime
			}

			items = append(items, accountInfoItem{
				Email:     email,
				AuthUser:  authUser,
				Label:     label,
				Status:    status,
				ResetTime: resetTime,
			})
		}
	}

	sort.Slice(items, func(i, j int) bool {
		return items[i].AuthUser < items[j].AuthUser
	})

	totalCount := len(items)
	activeCount := 0
	limitedCount := 0

	var cardsBuilder strings.Builder
	for _, it := range items {
		isLimited := it.Status == "rate_limited"
		if isLimited {
			limitedCount++
		} else {
			activeCount++
		}

		cardClass := "account-card"
		badgeHTML := `<span class="badge badge-active">● Cuota Activa</span>`
		resetBannerHTML := ""

		if isLimited {
			cardClass += " is-limited"
			badgeHTML = `<span class="badge badge-limited">⏳ Límite Alcanzado</span>`
			resetStr := it.ResetTime
			if resetStr == "" {
				resetStr = "Próximo ciclo web"
			}
			resetBannerHTML = fmt.Sprintf(`<div class="reset-banner">Se restablece: <strong>%s</strong></div>`, resetStr)
		}

		cardsBuilder.WriteString(fmt.Sprintf(`
    <div class="%s">
      <div>
        <div class="account-header">
          <div>
            <div class="account-email">%s</div>
            <div class="account-sub">Sesión u/%d</div>
          </div>
          %s
        </div>
        %s
      </div>
      <div class="meta-footer">
        <span>Google Gemini Web</span>
        <span>Modo Argon 4</span>
      </div>
    </div>`,
			cardClass,
			it.Email,
			it.AuthUser,
			badgeHTML,
			resetBannerHTML,
		))
	}

	out := string(accountsTemplateHTML)
	out = strings.ReplaceAll(out, "{{TOTAL_COUNT}}", fmt.Sprintf("%d", totalCount))
	out = strings.ReplaceAll(out, "{{ACTIVE_COUNT}}", fmt.Sprintf("%d", activeCount))
	out = strings.ReplaceAll(out, "{{LIMITED_COUNT}}", fmt.Sprintf("%d", limitedCount))
	out = strings.ReplaceAll(out, "{{CARDS_HTML}}", cardsBuilder.String())
	return out
}
