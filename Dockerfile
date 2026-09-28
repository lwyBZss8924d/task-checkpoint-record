# syntax=docker/dockerfile:1.7
# The named helper context must be the narrow output of package.py helper-context.
ARG NODE_IMAGE=node:22-bookworm-slim@sha256:43ac6c60b8f89723f746e8a92ce91abd5017e627ce1ddfe4238355d3a30b772c
ARG BUN_IMAGE=oven/bun:1.3.14@sha256:e10577f0db68676a7024391c6e5cb4b879ebd17188ab750cf10024a6d700e5c4
ARG CODEX_BASE=ghcr.io/openai/codex-universal@sha256:905e512f36460e1be4cfedb30928a8a28299edb0fcd5de7998ceaa72d27fe304
FROM ${NODE_IMAGE} AS helper-build
WORKDIR /helper
COPY --from=helper package.json package-lock.json tsconfig.json ./
RUN npm ci --ignore-scripts --no-audit --no-fund
COPY --from=helper src ./src
COPY --from=helper bin ./bin
COPY --from=helper LICENSE ./LICENSE
RUN npm run build

FROM ${BUN_IMAGE} AS bun-runtime

FROM ${CODEX_BASE} AS runtime
ARG TARGETARCH
USER root
COPY container/install-codex.py container/versions.json /tmp/codex-install/
RUN python3 /tmp/codex-install/install-codex.py --lock /tmp/codex-install/versions.json \
      --arch "$TARGETARCH" --prefix /opt/codex-runtime \
    && /opt/codex-runtime/bin/codex --version
COPY --from=bun-runtime /usr/local/bin/bun /usr/local/bin/bun
COPY --from=helper-build /usr/local/bin/node /usr/local/bin/node
COPY --from=helper-build /helper/dist /opt/ultrafast-atif-helper/dist
COPY --from=helper-build /helper/bin /opt/ultrafast-atif-helper/bin
COPY --from=helper-build /helper/package.json /helper/LICENSE /opt/ultrafast-atif-helper/
WORKDIR /opt/task-checkpoint-record
COPY package.json LICENSE ./
COPY bin ./bin
COPY src ./src
COPY config/codex-service.toml ./config/codex-service.toml
COPY config/task-checkpoint.container.example.json config/task-checkpoint.config.schema.json ./config/
COPY config/runtime.bunfig.toml ./config/runtime.bunfig.toml
COPY container/entrypoint.sh /usr/local/bin/task-checkpoint-entrypoint
COPY container/ultrafast-atif-helper /usr/local/bin/ultrafast-atif-helper
RUN chmod 755 /usr/local/bin/task-checkpoint-entrypoint /usr/local/bin/ultrafast-atif-helper /opt/task-checkpoint-record/bin/task-checkpoint-record \
    && chmod 755 /opt/ultrafast-atif-helper/bin/ultrafast-atif-helper.mjs \
    && useradd --create-home --uid 10001 --shell /bin/sh recorder \
    && mkdir -p /var/lib/task-checkpoint-record /var/lib/task-checkpoint-codex /inputs \
    && chown 10001:10001 /var/lib/task-checkpoint-record /var/lib/task-checkpoint-codex \
    && chmod 700 /var/lib/task-checkpoint-record /var/lib/task-checkpoint-codex
ENV HOME=/home/recorder \
    CODEX_HOME=/var/lib/task-checkpoint-codex \
    TASK_CHECKPOINT_RECORD_STATE=/var/lib/task-checkpoint-record \
    PATH=/opt/codex-runtime/bin:/usr/local/bin:/usr/bin:/bin
USER 10001:10001
WORKDIR /home/recorder
ENTRYPOINT ["/usr/local/bin/task-checkpoint-entrypoint"]
CMD ["--help"]
