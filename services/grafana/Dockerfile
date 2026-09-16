# syntax=docker/dockerfile:1
# No build step - dashboards/datasources are provisioned as code (checked into the repo),
# not clicked together in the UI, so a redeploy never loses them even though the container
# itself has no persistent storage (see docs/production-readiness.md for what that does and
# doesn't lose - user accounts and manual edits, not the dashboards below).
#   docker build -f services/grafana/Dockerfile -t tillflow-grafana:local .

FROM grafana/grafana-oss:11.3.1

COPY services/grafana/provisioning /etc/grafana/provisioning

EXPOSE 3004
HEALTHCHECK --interval=30s --timeout=3s --retries=3 \
  CMD wget -qO- http://localhost:3004/grafana/api/health || exit 1
