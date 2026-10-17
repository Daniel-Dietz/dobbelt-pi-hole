# syntax=docker/dockerfile:1.7
FROM nginx:1.30.6-alpine3.24@sha256:970364228b1e4f932abc22d321932816782cca8a20b85a77552a7cfe9acfb3b5

RUN apk add --no-cache python3 ca-certificates \
    && mkdir -p /opt/dobbelt-pi-hole /run/dobbelt-pi-hole /usr/share/licenses/dobbelt-pi-hole /usr/share/licenses/chart.js \
    && chown 101:101 /run/dobbelt-pi-hole

COPY tools/render_config.py /opt/dobbelt-pi-hole/render_config.py
COPY container/docker-entrypoint.sh /docker-entrypoint.sh
COPY container/nginx.conf /etc/nginx/nginx.conf
COPY index.html /usr/share/nginx/html/index.html
COPY LICENSE /usr/share/licenses/dobbelt-pi-hole/LICENSE

# Download and verify the local chart library and its license at image build time.
ADD --checksum=sha256:81ffafe13c37e1b25793b020d446f4d9739b949dadb7f9f79d709a0cad781c2f \
    https://cdnjs.cloudflare.com/ajax/libs/Chart.js/4.4.1/chart.umd.min.js /usr/share/nginx/html/chart.umd.min.js
ADD --checksum=sha256:5a0877ad6d818529be4f33009d0942cdf7e2ed7656156f4aba7308459a546030 \
    https://raw.githubusercontent.com/chartjs/Chart.js/v4.4.1/LICENSE.md /usr/share/licenses/chart.js/LICENSE

RUN chmod 0555 /docker-entrypoint.sh \
    && chmod 0444 /opt/dobbelt-pi-hole/render_config.py /etc/nginx/nginx.conf \
        /usr/share/nginx/html/index.html /usr/share/nginx/html/chart.umd.min.js \
        /usr/share/licenses/dobbelt-pi-hole/LICENSE /usr/share/licenses/chart.js/LICENSE

ENV PYTHONDONTWRITEBYTECODE=1
USER 101:101
EXPOSE 8080
HEALTHCHECK --interval=30s --timeout=3s --start-period=10s --retries=3 \
    CMD ["python3", "-c", "import urllib.request; urllib.request.urlopen('http://127.0.0.1:8080/healthz', timeout=2).read()"]
ENTRYPOINT ["/docker-entrypoint.sh"]
CMD ["nginx", "-g", "daemon off;"]
