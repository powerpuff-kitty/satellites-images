# Security policy

## Reporting a vulnerability

Please **do not** open a public issue for a security problem.

Report privately through GitHub:
[**Report a vulnerability**](https://github.com/powerpuff-kitty/satellites-images/security/advisories/new)
(Security → Advisories → Report a vulnerability). That channel is private to the maintainers.

Please include: affected package and version, the smallest reproduction you can manage, the
impact you believe it has, and whether the issue is already public anywhere.

**Expectations:** acknowledgement within 5 working days, an initial assessment within 10
working days, and a fix or a documented decision as soon as is practical. Credit is offered in
the advisory unless you ask otherwise.

## Supported versions

The packages are not yet published to npm, PyPI or crates.io. Until the first release,
security fixes target the `main` branch only; there are no supported older versions.

## Scope

In scope:

- the SDKs (`packages/typescript`, `packages/python`, `crates/satellites-images`) — request
  construction, response parsing, URL/redirect handling, bounding-box and AOI maths, retry and
  pagination behaviour;
- the explorer app (`apps/explorer`) — the MapLibre map, the proxy configuration, rendering of
  provider-supplied metadata and image URLs, and the URL/permalink handling;
- automation in `.github/workflows` — token permissions, action pinning, privileged triggers.

Out of scope:

- the public catalogues themselves (Earth Search, Planetary Computer, Copernicus, ASF, NASA
  CMR, JAXA, ESA plans). Report those to the operator; this project only reads their public
  metadata;
- imagery access terms, licences and accuracy of upstream metadata;
- anything requiring credentials the project does not hold, and denial of service against
  third-party services.

## Design notes relevant to security

- The SDKs are read-only: they fetch public metadata and never download or upload imagery.
- Provider-supplied URLs are validated (HTTPS, same-origin pagination) before use; see
  `docs/ARCHITECTURE.md`.
- No credentials are stored or required. The optional ESA proxy is operator-supplied and holds
  no secrets in this repository.
- The browser explorer renders provider metadata as text and images from provider URLs; it
  does not execute provider content.
