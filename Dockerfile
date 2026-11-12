# syntax=docker/dockerfile:1

# The runtime base matches the release runner (ubuntu-22.04) that builds the
# troupe-server assets, so the binary loads the same library versions it was
# linked against.
ARG UBUNTU_VERSION=22.04

# 22.04 has no minisign package, so the download stage uses 24.04.
FROM ubuntu:24.04 AS fetch
ARG TARGETARCH
# A GitHub release tag (v0.5.0, nightly), or "latest" for the newest stable release.
# TROUPE_RELEASE wins; the old TERMUL_RELEASE build arg still works.
ARG TERMUL_RELEASE=latest
ARG TROUPE_RELEASE=${TERMUL_RELEASE}
RUN apt-get update \
	&& apt-get install -y --no-install-recommends ca-certificates curl minisign \
	&& rm -rf /var/lib/apt/lists/*
COPY src-tauri/tauri.conf.json /tmp/tauri.conf.json
WORKDIR /fetch
# Releases before 0.5.0 name the asset termul-server, so fall back to that name.
RUN set -eu; \
	case "$TARGETARCH" in \
		amd64) suffix= ;; \
		arm64) suffix=-linux-aarch64 ;; \
		*) echo "unsupported TARGETARCH: $TARGETARCH" >&2; exit 1 ;; \
	esac; \
	if [ "$TROUPE_RELEASE" = latest ]; then \
		base=https://github.com/gnoviawan/troupe/releases/latest/download; \
	else \
		base="https://github.com/gnoviawan/troupe/releases/download/$TROUPE_RELEASE"; \
	fi; \
	for asset in "troupe-server$suffix" "termul-server$suffix"; do \
		if curl -fsSL --proto '=https' --retry 3 -o troupe-server "$base/$asset"; then break; fi; \
		rm -f troupe-server; \
	done; \
	test -s troupe-server || { echo "no server asset in release $TROUPE_RELEASE" >&2; exit 1; }; \
	curl -fsSL --proto '=https' --retry 3 -o troupe-server.sig "$base/$asset.sig"; \
	sed -n 's/.*"pubkey": *"\([^"]*\)".*/\1/p' /tmp/tauri.conf.json | base64 -d > minisign.pub; \
	base64 -d troupe-server.sig > troupe-server.minisig; \
	minisign -V -m troupe-server -x troupe-server.minisig -p minisign.pub; \
	chmod 0755 troupe-server

FROM ubuntu:${UBUNTU_VERSION}
ARG TERMUL_RELEASE=latest
ARG TERMUL_UID=1000
ARG TERMUL_GID=1000
ARG TROUPE_RELEASE=${TERMUL_RELEASE}
ARG TROUPE_UID=${TERMUL_UID}
ARG TROUPE_GID=${TERMUL_GID}

LABEL org.opencontainers.image.title="troupe-server" \
	org.opencontainers.image.description="Standalone Troupe server: browser terminals, git, and ACP agents over HTTP and WebSocket" \
	org.opencontainers.image.source="https://github.com/gnoviawan/troupe" \
	org.opencontainers.image.licenses="MIT" \
	org.opencontainers.image.version="${TROUPE_RELEASE}"

# troupe-server links WebKitGTK and GTK through the shared Tauri crate even
# though the server never opens a window. The ldd check below fails the build
# if a linked library is missing.
RUN apt-get update \
	&& apt-get install -y --no-install-recommends \
		bash \
		ca-certificates \
		curl \
		git \
		less \
		libwebkit2gtk-4.1-0 \
		openssh-client \
		procps \
		tini \
	&& rm -rf /var/lib/apt/lists/* \
	&& groupadd --non-unique --gid "$TROUPE_GID" termul \
	&& useradd --non-unique --uid "$TROUPE_UID" --gid termul --create-home --shell /bin/bash termul \
	&& mkdir -p /home/termul/.local/bin /home/termul/.local/state/termul /workspace \
	&& chown -R termul:termul /home/termul /workspace

# termul-server stays as a link so compose files and scripts that name the old
# binary keep working.
COPY --from=fetch /fetch/troupe-server /usr/local/bin/troupe-server
RUN ln -s troupe-server /usr/local/bin/termul-server \
	&& if ldd /usr/local/bin/troupe-server | grep 'not found'; then exit 1; fi

ENV HOME=/home/termul \
	PATH=/home/termul/.local/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin \
	LANG=C.UTF-8

USER termul
WORKDIR /workspace
EXPOSE 8080

HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
	CMD curl -fsS http://127.0.0.1:8080/health > /dev/null || exit 1

# A public bind with no TROUPE_WEB_AUTH_TOKEN makes the server generate a token
# into <state dir>/web-auth-token and refuse unauthenticated clients.
ENTRYPOINT ["/usr/bin/tini", "--", "/usr/local/bin/troupe-server"]
CMD ["--host", "0.0.0.0", "--port", "8080", "--state-dir", "/home/termul/.local/state/termul"]
