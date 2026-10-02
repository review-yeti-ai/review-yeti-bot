# Canonical finding read consumers

Refs: REL-1265, UAT-1728.
Base: protected I1 c4f1d23b29fa05446577148fd86a1dcb0ccf1acb.
Adopt the original PR1258 read-consumer slice in resource, listing, explanation, and fix-diff tools.
Retain all 230 lines and 11 cases of the original roundtrip test, plus the protected nine core cases.
The unchanged protected baseline and immediate replay each passed 10/11; resource/listing IDs disagreed.
Canonical IDs now share persona and end-line identity; unique legacy aliases remain accepted, collisions rejected.
Dispute writers, registration/router, publisher markers, RBAC, and defaults stay unchanged.
Source qualification and ordinary Draft CI precede Ready admission; no live activation is claimed.
Review controls reproduce line-only/file-alias coordinate drift and the first-row-wins oracle gap; shared coordinates and additive oldest-first/tie assertions repair them without changing the original cases.
