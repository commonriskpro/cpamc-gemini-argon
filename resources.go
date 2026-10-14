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

		cardClass := "card"
		badgeHTML := `<span class="kpi-badge" style="color:var(--meter-text-green); border-color:rgba(35,134,54,0.4);"><span style="color:var(--meter-text-green);">●</span> Activa</span>`
		percentColor := "color:var(--meter-text-green);"
		quotaPercent := "100%"
		quotaFillClass := "fill"
		quotaFillWidth := "100%"
		quotaStatusText := "Disponible"
		resetAlertHTML := ""
		footerStatusColor := "var(--meter-text-green)"
		footerStatusText := "● En Rotación"

		if isLimited {
			cardClass += " is-limited"
			badgeHTML = `<span class="kpi-badge" style="color:var(--meter-text-warning); border-color:rgba(210,153,34,0.4);"><span style="color:var(--meter-text-warning);">⏳</span> Limitada</span>`
			percentColor = "color:var(--meter-text-warning);"
			quotaPercent = "0%"
			quotaFillClass = "fill critical"
			quotaFillWidth = "6%"
			quotaStatusText = "Agotada"
			footerStatusColor = "var(--meter-text-warning)"
			footerStatusText = "⏳ En enfriamiento"
			resetStr := it.ResetTime
			if resetStr == "" {
				resetStr = "Próximo ciclo web"
			}
			resetAlertHTML = fmt.Sprintf(`<div class="reset-alert"><span>⏳</span><span>Se restablece: <strong>%s</strong></span></div>`, resetStr)
		}

		cardsBuilder.WriteString(fmt.Sprintf(`
    <div class="%s">
      <div class="card-head">
        <div style="font-size:18px; line-height:1; color:#38bdf8;">⚡</div>
        <div class="card-title-col">
          <div class="file-name" title="%s">%s</div>
          <div class="prefix-row">
            <span class="prefix-label">Sesión:</span>
            <span class="prefix-text">u/%d</span>
            <span style="color:var(--border-color);">&bull;</span>
            <span class="prefix-label">Provider:</span>
            <span class="prefix-text">gemini-argon</span>
          </div>
        </div>
        %s
      </div>
      <div class="card-body">
        <div class="meter-row">
          <div class="meter-header">
            <span class="meter-label">Cuota Gemini 4 Argon</span>
            <div class="meter-meta">
              <span class="meta-percent" style="%s">%s</span>
              <span class="meta-reset-soon">%s</span>
            </div>
          </div>
          <div class="track">
            <div class="%s" style="width: %s;"></div>
          </div>
          %s
        </div>
        <div class="meter-row">
          <div class="meter-header">
            <span class="meter-label">Sesión Safari / Cookies</span>
            <div class="meter-meta">
              <span class="meta-percent" style="color:var(--meter-text-green);">Vigente</span>
            </div>
          </div>
          <div class="track">
            <div class="fill" style="width: 100%%;"></div>
          </div>
        </div>
      </div>
      <div class="card-footer">
        <div class="footer-left">
          <span>Modo:</span>
          <span style="color:var(--text-secondary); font-weight:600;">Argon 4 Thinking</span>
        </div>
        <div class="footer-right">
          <span style="font-family:var(--font-mono); font-size:11px; color:%s;">%s</span>
        </div>
      </div>
    </div>`,
			cardClass,
			it.Email,
			it.Email,
			it.AuthUser,
			badgeHTML,
			percentColor,
			quotaPercent,
			quotaStatusText,
			quotaFillClass,
			quotaFillWidth,
			resetAlertHTML,
			footerStatusColor,
			footerStatusText,
		))
	}

	out := string(accountsTemplateHTML)
	out = strings.ReplaceAll(out, "{{TOTAL_COUNT}}", fmt.Sprintf("%d", totalCount))
	out = strings.ReplaceAll(out, "{{ACTIVE_COUNT}}", fmt.Sprintf("%d", activeCount))
	out = strings.ReplaceAll(out, "{{LIMITED_COUNT}}", fmt.Sprintf("%d", limitedCount))
	out = strings.ReplaceAll(out, "{{CARDS_HTML}}", cardsBuilder.String())
	return out
}
