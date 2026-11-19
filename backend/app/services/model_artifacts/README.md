# Model artifacts

- `lstm_wco.pt` + `scaler.npz` — the **bundled pre-audit model** (trained before
  November 2026; its scaler was fitted on all data, including the validation
  period). The API uses it only while the database has no active model version.
- `versions/<version>/` — a **local cache** of models trained by the backend
  (gitignored). The authoritative copy of every trained version — weights,
  scaler, metrics, dataset fingerprint — is the `model_versions` table, so models
  survive restarts and redeploys on hosts with an ephemeral filesystem.
  Cached files are checksum-verified against the database before use.

You no longer copy files here by hand: retraining (automatic on data changes,
or Admin → "Retrain now" / `POST /api/v1/forecast/train`) creates and activates
new versions. See `docs/ML_TRAINING_AND_EVALUATION.md`.
