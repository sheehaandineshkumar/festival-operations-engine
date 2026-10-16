@@
 ## New features added in feature/profiles-requests-decisionlog
 - Configuration-driven festival profiles under `/profiles/*.json` (Durga Puja, Jagannath Rath Yatra, Chhath Puja). Profiles contain nodes, edges, thresholds, waste type multipliers and volunteer pools.
 - Request intake API (`POST /api/requests`) and server-side per-request decisioning (Allocated / Diverted / Rejected). Decisions take into account current reports and already-allocated groups.
 - Persistent state in `state.json` now stores reports, requests, allocations and a decision log. The server appends decisions and allocations to this file.
 - New APIs:
   - `GET /api/profiles` - list available profiles
   - `GET /api/profile?id=<id>` - fetch a profile JSON
   - `POST /api/requests` - submit a group request (body: { profile, closed, request })
   - `GET /api/requests` - list submitted requests
   - `GET /api/allocations` - list allocations
   - `GET /api/decisionlog` - read the decision log
+  - `DELETE /api/decisionlog` - clear the decision log (admins only; requires login)
   - `DELETE /api/reports` - clear field reports (existing)
   - `POST /api/reports` - submit field reports (existing)
   - `POST /api/plan` - returns the engine plan plus allocations and decision log
@@
 - Timeslot handling: I added timeslotMinutes in each profile (15 min). The server-side decisioning now performs strict slot reservations: requests are allocated to a slot (an integer index, computed from the wall clock and profile.timeslotMinutes). The judge searches the next 48 slots for a node with capacity and reserves it. Requests without preferredSlots will be scheduled to the earliest slot with capacity.
@@
 ## Demo notes
 - I added a basic request intake form and a Decision log textarea to the dashboard. Submit a group request to see Allocated/Diverted/Rejected decisions.
 - A read-only demo mode and more sophisticated timeline simulation will follow in the next PR, but the core allocation, profiles, decision log and persistent state are in this branch.
+ - New: Decision log can be cleared by admins from the dashboard; this calls DELETE /api/decisionlog (login required).
