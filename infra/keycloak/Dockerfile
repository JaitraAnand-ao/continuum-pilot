# CMP-6: Keycloak in FIPS strict mode (AD-6). Build from this directory:
#   docker build . --build-arg KEYCLOAK_DIGEST=sha256:... --build-arg BC_FIPS_SHA256=... \
#     --build-arg BCTLS_FIPS_SHA256=... --build-arg BCUTIL_FIPS_SHA256=...
# The digest and checksums have no defaults, so a build without the reviewed values fails.
ARG KEYCLOAK_VERSION=26.8.1
ARG KEYCLOAK_DIGEST

FROM quay.io/keycloak/keycloak:${KEYCLOAK_VERSION}@${KEYCLOAK_DIGEST} AS builder

ARG BC_FIPS_VERSION=2.0.0
ARG BCTLS_FIPS_VERSION=2.0.19
ARG BCUTIL_FIPS_VERSION=2.0.3
ARG BC_FIPS_SHA256
ARG BCTLS_FIPS_SHA256
ARG BCUTIL_FIPS_SHA256

# BouncyCastle FIPS: the certified provider Keycloak's fips feature runs on (versions per the Keycloak FIPS guide).
ADD --chown=keycloak:keycloak --checksum=sha256:${BC_FIPS_SHA256} https://repo1.maven.org/maven2/org/bouncycastle/bc-fips/${BC_FIPS_VERSION}/bc-fips-${BC_FIPS_VERSION}.jar /opt/keycloak/providers/
ADD --chown=keycloak:keycloak --checksum=sha256:${BCTLS_FIPS_SHA256} https://repo1.maven.org/maven2/org/bouncycastle/bctls-fips/${BCTLS_FIPS_VERSION}/bctls-fips-${BCTLS_FIPS_VERSION}.jar /opt/keycloak/providers/
ADD --chown=keycloak:keycloak --checksum=sha256:${BCUTIL_FIPS_SHA256} https://repo1.maven.org/maven2/org/bouncycastle/bcutil-fips/${BCUTIL_FIPS_VERSION}/bcutil-fips-${BCUTIL_FIPS_VERSION}.jar /opt/keycloak/providers/

COPY conf/keycloak.conf /opt/keycloak/conf/keycloak.conf
RUN /opt/keycloak/bin/kc.sh build

FROM quay.io/keycloak/keycloak:${KEYCLOAK_VERSION}@${KEYCLOAK_DIGEST}

COPY --from=builder /opt/keycloak/ /opt/keycloak/
# Only the production realm; the fake-entra realm is mounted by Compose locally and never shipped.
COPY --chown=keycloak:keycloak realms/signin-reports-realm.json /opt/keycloak/data/import/
COPY --chmod=0555 docker-entrypoint.sh /opt/keycloak/bin/sr-entrypoint.sh

USER 1000
EXPOSE 8443 9000
ENTRYPOINT ["/opt/keycloak/bin/sr-entrypoint.sh"]
CMD ["start", "--optimized", "--import-realm"]
