# The service runs here because it needs tshark, and tshark is a Wireshark
# install rather than a Python package. Nothing in aggregation/ needs this
# image -- that layer is pure and tests on the host.

FROM python:3.12-slim AS base

# tshark's postinst asks whether non-root users may capture. This service only
# ever reads files, so the answer is no and the question must not block a
# non-interactive build.
RUN echo 'wireshark-common wireshark-common/install-setuid boolean false' \
      | debconf-set-selections \
 && apt-get update \
 && DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends \
      tshark \
 && rm -rf /var/lib/apt/lists/*

COPY --from=ghcr.io/astral-sh/uv:0.9 /uv /uvx /bin/

ENV UV_COMPILE_BYTECODE=1 \
    UV_LINK_MODE=copy \
    UV_PROJECT_ENVIRONMENT=/opt/venv \
    PATH=/opt/venv/bin:$PATH \
    PYTHONUNBUFFERED=1

WORKDIR /srv

# Dependencies first, so a source edit does not reinstall the world.
COPY pyproject.toml uv.lock ./
RUN uv sync --locked --no-dev --no-install-project

COPY app ./app

EXPOSE 8000
CMD ["uvicorn", "app.main:app", "--host", "0.0.0.0", "--port", "8000"]


# Everything above, plus the dev dependencies. This is what compose runs and
# what the tshark-dependent tests run inside; a deployed image would stop at
# `base`.
FROM base AS dev

RUN --mount=type=cache,target=/root/.cache/uv \
    uv sync --locked --no-install-project

COPY tests ./tests
