package main

import (
	"context"
	"sync"
)

type pluginLifecycle struct {
	mu       sync.Mutex
	draining bool
	calls    sync.WaitGroup
	workers  sync.WaitGroup
	active   map[*streamWorker]struct{}
}

type streamWorker struct {
	mu         sync.Mutex
	cancel     context.CancelFunc
	upstreamID string
}

var lifecycle = pluginLifecycle{active: make(map[*streamWorker]struct{})}

var pluginState struct {
	mu           sync.Mutex
	active       bool
	shuttingDown bool
}

func beginPluginInit() bool {
	pluginState.mu.Lock()
	defer pluginState.mu.Unlock()
	if pluginState.active || pluginState.shuttingDown {
		return false
	}
	pluginState.active = true
	return true
}

func abortPluginInit() {
	pluginState.mu.Lock()
	pluginState.active = false
	pluginState.mu.Unlock()
}

func beginPluginShutdown() bool {
	pluginState.mu.Lock()
	defer pluginState.mu.Unlock()
	if !pluginState.active || pluginState.shuttingDown {
		return false
	}
	pluginState.active = false
	pluginState.shuttingDown = true
	return true
}

func finishPluginShutdown() {
	pluginState.mu.Lock()
	pluginState.shuttingDown = false
	pluginState.mu.Unlock()
}

func beginPluginCall(method string) bool {
	pluginState.mu.Lock()
	defer pluginState.mu.Unlock()
	if !pluginState.active || pluginState.shuttingDown {
		return false
	}
	lifecycle.mu.Lock()
	defer lifecycle.mu.Unlock()
	if lifecycle.draining && method != methodPluginQuiesce && method != methodReconfigure {
		return false
	}
	lifecycle.calls.Add(1)
	return true
}

func endPluginCall() { lifecycle.calls.Done() }

func quiescePlugin() {
	lifecycle.mu.Lock()
	lifecycle.draining = true
	lifecycle.mu.Unlock()
}

func reopenPluginLifecycle() bool {
	pluginState.mu.Lock()
	defer pluginState.mu.Unlock()
	if !pluginState.active || pluginState.shuttingDown {
		return false
	}
	lifecycle.mu.Lock()
	lifecycle.draining = false
	lifecycle.mu.Unlock()
	return true
}

func shutdownPlugin() {
	quiescePlugin()
	lifecycle.mu.Lock()
	workers := make([]*streamWorker, 0, len(lifecycle.active))
	for w := range lifecycle.active {
		workers = append(workers, w)
		w.cancel()
	}
	lifecycle.mu.Unlock()
	lifecycle.workers.Wait()
	lifecycle.calls.Wait()
}

func resetPluginLifecycle() {
	lifecycle.mu.Lock()
	lifecycle.draining = false
	lifecycle.mu.Unlock()
}
