.PHONY: all build build-linux-amd64 build-linux-arm64 build-all clean test

all: build

build:
	./build.sh

build-linux-amd64:
	GOOS=linux GOARCH=amd64 ./build.sh

build-linux-arm64:
	GOOS=linux GOARCH=arm64 ./build.sh

build-all: build build-linux-amd64 build-linux-arm64

clean:
	rm -rf dist cpamc-gemini-argon.dylib cpamc-gemini-argon.so cpamc-gemini-argon.dll cpamc-gemini-argon.h

test:
	go vet ./...
	node -c gemini_runner.js
