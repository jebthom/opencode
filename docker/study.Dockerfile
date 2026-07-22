# Aperture study image — the frozen interface under study.
#
# Built once per study from a pinned Aperture SHA and pushed to GHCR; the target repos
# (matplotlib, retro-game-store) consume it by tag and never build Aperture from source.
# That is the whole point: study 1 stays reproducible after Aperture's source moves on.
#
# Deliberately contains nothing repo-specific — no target repos, no venvs, no secrets.
# The one exception is the matplotlib tarball cache, which is a *build input* for the
# target repo's setup and must not depend on a live 2026 fetch from SourceForge.
FROM mcr.microsoft.com/devcontainers/base:ubuntu

# python3-venv is not in base:ubuntu; without it `python3 -m venv` fails. The rest is the
# matplotlib 3.8 extension build chain (still setup.py + setupext.py at this vintage —
# the Meson port didn't land until 3.9, and C++17 isn't required yet, so stock g++ is fine).
RUN apt-get update && apt-get install -y --no-install-recommends \
      python3-dev python3-venv make g++ pkg-config \
      libfreetype6-dev libpng-dev \
    && rm -rf /var/lib/apt/lists/*

# matplotlib's get_from_cache_or_download reads ~/.cache/matplotlib/<sha256> — the filename
# *is* the sha256, no extension — before touching the network. Seeding it here keeps freetype
# vendored at 2.6.1 (mpl pins it for pixel-exact image comparison; system freetype 2.13 breaks
# the image tests) without a live download at codespace-create time.
COPY --chown=vscode:vscode docker/vendor/freetype-2.6.1.tar.gz \
     /home/vscode/.cache/matplotlib/0a3c7dfbda6da1e8fce29232e8e96d987ababbbf71ebc8c75659e4132c367014
COPY --chown=vscode:vscode docker/vendor/qhull-2020-src-8.0.2.tgz \
     /home/vscode/.cache/matplotlib/b5c2d7eb833278881b952c8a52d20179eab87766b00b865000469a45c1838b7e

# `bun run dev` must be invoked from the Aperture repo root (the script is defined there and
# uses --cwd packages/opencode), but the participant's cwd is /workspaces/<target>. Resolve the
# target to an absolute path *before* cd'ing away, since the CLI resolves a relative positional
# against $PWD (packages/opencode/src/cli/cmd/tui/thread.ts:72).
COPY docker/aperture-wrapper.sh /usr/local/bin/aperture
RUN chmod 0755 /usr/local/bin/aperture

RUN mkdir -p /opt/aperture && chown vscode:vscode /opt/aperture
USER vscode

# Pinned exactly to the repo's packageManager field. This — not a node version — is the pin
# that matters: Aperture runs on bun, node-pty is consumed as a prebuilt binary (so there is no
# node ABI to drift), and `bun run` supplies a node shim for the extension's esbuild step.
ARG BUN_VERSION=1.3.14
RUN curl -fsSL https://bun.sh/install | bash -s "bun-v${BUN_VERSION}"
# ENV, not `export` in a lifecycle command — that would die with the command that ran it.
ENV PATH="/home/vscode/.bun/bin:${PATH}"

ARG APERTURE_SHA
RUN test -n "${APERTURE_SHA}" || (echo "APERTURE_SHA build arg is required" >&2; exit 1)
RUN git clone https://github.com/aperture-study/aperture /opt/aperture \
 && cd /opt/aperture \
 && git checkout "${APERTURE_SHA}" \
 && bun install \
 && cd sdks/aperture-vscode \
 && bun install \
 && bash package-vsix.sh \
 && cp aperture-0.0.1.vsix /opt/aperture/aperture.vsix

# Fail the build here rather than in a participant's codespace. (Plain shell rather than a
# heredoc, so the Dockerfile doesn't depend on a BuildKit syntax directive.)
RUN test -f /opt/aperture/aperture.vsix \
 && bun --version | grep -qx "${BUN_VERSION}" \
 && cd /home/vscode/.cache/matplotlib \
 && for f in \
      0a3c7dfbda6da1e8fce29232e8e96d987ababbbf71ebc8c75659e4132c367014 \
      b5c2d7eb833278881b952c8a52d20179eab87766b00b865000469a45c1838b7e; do \
      echo "$f  $f" | sha256sum -c -; \
    done

LABEL org.opencontainers.image.source="https://github.com/aperture-study/aperture"
LABEL org.opencontainers.image.description="Aperture prototype, frozen for the Codespaces user study"
