# Changelog

## Unreleased

- Hardened production SQLite configuration and added schema migration tracking.
- Added safer API/Socket error responses with request IDs and room state versions.
- Added Android release APK verification.
- Added regression tests for mobile abort handling and poker action validation.
- Bumped the mobile client build to 3 and rejected older installed clients at auth and Socket entrypoints.
