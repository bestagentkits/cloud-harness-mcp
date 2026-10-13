FROM debian:bookworm-slim

RUN apt-get update \
  && apt-get install -y --no-install-recommends \
    iptables \
    iproute2 \
  && rm -rf /var/lib/apt/lists/*

ENTRYPOINT ["/sbin/iptables-save"]
