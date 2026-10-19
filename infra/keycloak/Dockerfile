# syntax=docker/dockerfile:1
# CMP-6: the FIPS Keycloak 26.8.1 image production runs (AD-6), built from source.
# The base is pinned by digest and each BouncyCastle FIPS jar by SHA-256; both are build
# arguments without defaults, so a build that does not pin them fails instead of floating.
ARG KEYCLOAK_DIGEST

FROM quay.io/keycloak/keycloak:26.8.1@${KEYCLOAK_DIGEST} AS builder
ARG BC_FIPS_VERSION=2.0.0
ARG BCTLS_FIPS_VERSION=2.0.19
ARG BCPKIX_FIPS_VERSION=2.0.7
ARG BCUTIL_FIPS_VERSION=2.0.3
ARG BC_FIPS_SHA256
ARG BCTLS_FIPS_SHA256
ARG BCPKIX_FIPS_SHA256
ARG BCUTIL_FIPS_SHA256
ADD --chown=1000:0 https://repo1.maven.org/maven2/org/bouncycastle/bc-fips/${BC_FIPS_VERSION}/bc-fips-${BC_FIPS_VERSION}.jar /opt/keycloak/providers/
ADD --chown=1000:0 https://repo1.maven.org/maven2/org/bouncycastle/bctls-fips/${BCTLS_FIPS_VERSION}/bctls-fips-${BCTLS_FIPS_VERSION}.jar /opt/keycloak/providers/
ADD --chown=1000:0 https://repo1.maven.org/maven2/org/bouncycastle/bcpkix-fips/${BCPKIX_FIPS_VERSION}/bcpkix-fips-${BCPKIX_FIPS_VERSION}.jar /opt/keycloak/providers/
ADD --chown=1000:0 https://repo1.maven.org/maven2/org/bouncycastle/bcutil-fips/${BCUTIL_FIPS_VERSION}/bcutil-fips-${BCUTIL_FIPS_VERSION}.jar /opt/keycloak/providers/
WORKDIR /opt/keycloak/providers
RUN printf '%s  %s\n' \
      "${BC_FIPS_SHA256}" "bc-fips-${BC_FIPS_VERSION}.jar" \
      "${BCTLS_FIPS_SHA256}" "bctls-fips-${BCTLS_FIPS_VERSION}.jar" \
      "${BCPKIX_FIPS_SHA256}" "bcpkix-fips-${BCPKIX_FIPS_VERSION}.jar" \
      "${BCUTIL_FIPS_SHA256}" "bcutil-fips-${BCUTIL_FIPS_VERSION}.jar" \
    | sha256sum --check --strict
COPY --chown=1000:0 conf/keycloak.conf /opt/keycloak/conf/keycloak.conf
RUN /opt/keycloak/bin/kc.sh build --features=fips --fips-mode=strict --db=postgres --health-enabled=true --metrics-enabled=true

FROM quay.io/keycloak/keycloak:26.8.1@${KEYCLOAK_DIGEST}
COPY --from=builder --chown=1000:0 /opt/keycloak/ /opt/keycloak/
# Only the production realm: the local stand-in for Entra is mounted by Compose, never baked in.
COPY --chown=1000:0 --chmod=0444 realms/signin-reports-realm.json /opt/keycloak/data/import/signin-reports-realm.json
COPY --chown=1000:0 --chmod=0555 docker-entrypoint.sh /opt/keycloak/bin/docker-entrypoint.sh
USER 1000
EXPOSE 8443 9000
ENTRYPOINT ["/opt/keycloak/bin/docker-entrypoint.sh"]
CMD ["start", "--optimized", "--import-realm"]
