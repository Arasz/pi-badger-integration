# Google Vertex AI with Application Default Credentials (ADC)

Google Cloud Vertex AI provides access to Gemini models with Google Cloud quotas and billing. This guide walks through configuring Pi to use Vertex AI with Application Default Credentials (ADC), matching the setup pattern used by Hermes Agent.

## How it works

Vertex AI authenticates with OAuth2 access tokens minted by Google Cloud SDKs. There is no static API key for this path.

In Hermes Agent, Vertex AI is configured with a GCP project ID and a region (defaulting to `global`) under the `vertex:` key in `config.yaml`, and it picks up credentials from ADC or a service account key file.

Pi has a built-in `google-vertex` provider implemented in `@earendil-works/pi-ai` using the `@google/genai` Node.js SDK. When you run `gcloud auth application-default login`, gcloud writes user credentials to `~/.config/gcloud/application_default_credentials.json`. Pi reads this file automatically. To complete the handshake, Pi needs to know which Google Cloud project and region to route calls to.

You provide these settings in two places:
1. In `~/.pi/agent/auth.json`, which gives Pi provider-scoped environment variables.
2. In `~/.zshrc`, which guarantees subshells and external tools see the project and region.

## Prerequisites

1. A Google Cloud project with the Vertex AI API enabled.
2. The `roles/aiplatform.user` IAM role on that project for your Google account.
3. The Google Cloud CLI (`gcloud`) installed on your system.

## 1. Authenticate with gcloud

Create Application Default Credentials by logging in with the gcloud CLI:

```bash
gcloud auth application-default login
```

This opens a browser window to grant Google Cloud access. Once approved, credentials land at `~/.config/gcloud/application_default_credentials.json`.

Confirm the credential file exists:

```bash
test -f ~/.config/gcloud/application_default_credentials.json && echo "ADC credentials present"
```

## 2. Configure Pi authentication (`~/.pi/agent/auth.json`)

Pi stores provider credentials in `~/.pi/agent/auth.json`. For ADC, you do not supply a static key. Instead, you supply the `GOOGLE_CLOUD_PROJECT` and `GOOGLE_CLOUD_LOCATION` environment variables inside the provider entry.

Update `~/.pi/agent/auth.json` with the `google-vertex` block:

```json
{
  "google-vertex": {
    "type": "api_key",
    "env": {
      "GOOGLE_CLOUD_PROJECT": "your-gcp-project-id",
      "GOOGLE_CLOUD_LOCATION": "global"
    }
  }
}
```

Important detail: do not set a `key` field for ADC. When `key` is absent, Pi resolves the entry through its ADC path, forwarding the `env` object directly to the Vertex client. If a dummy key is present, Pi assumes an API key and skips passing the project environment.

Keep the file permissions restricted:

```bash
chmod 600 ~/.pi/agent/auth.json
```

## 3. Set persistent environment variables (`~/.zshrc`)

Export the project ID and location in your shell startup file so CLI tools and background workers share the configuration:

```bash
cat << 'EOF' >> ~/.zshrc

# Google Cloud Vertex AI (ADC)
export GOOGLE_CLOUD_PROJECT="your-gcp-project-id"
export GOOGLE_CLOUD_LOCATION="global"
export GOOGLE_GENAI_USE_ENTERPRISE="true"
EOF
```

Load them into your current shell:

```bash
source ~/.zshrc
```

## 4. Configure model aliases (`~/.pi/agent/models.json`)

Pi includes built-in models for `google-vertex` with bare names like `gemini-2.5-flash` and `gemini-3.8-flash`. Hermes Agent uses prefixed names like `google/gemini-3.8-flash`.

To let Pi accept both formats without custom-model warnings, add aliases in `~/.pi/agent/models.json`:

```json
{
  "providers": {
    "google-vertex": {
      "models": [
        {
          "id": "google/gemini-3.8-flash",
          "name": "Google: Gemini 3.8 Flash (Vertex)",
          "api": "google-vertex",
          "reasoning": true,
          "input": ["text", "image"],
          "cost": { "input": 0.5, "output": 3.0, "cacheRead": 0.05, "cacheWrite": 0 },
          "contextWindow": 1048576,
          "maxTokens": 65536
        },
        {
          "id": "google/gemini-3.7-flash",
          "name": "Google: Gemini 3.7 Flash (Vertex)",
          "api": "google-vertex",
          "reasoning": true,
          "input": ["text", "image"],
          "cost": { "input": 0.5, "output": 3.0, "cacheRead": 0.05, "cacheWrite": 0 },
          "contextWindow": 1048576,
          "maxTokens": 65536
        },
        {
          "id": "google/gemini-3.1-pro-preview",
          "name": "Google: Gemini 3.1 Pro Preview (Vertex)",
          "api": "google-vertex",
          "reasoning": true,
          "input": ["text", "image"],
          "cost": { "input": 1.25, "output": 10.0, "cacheRead": 0.125, "cacheWrite": 0 },
          "contextWindow": 1048576,
          "maxTokens": 65536
        },
        {
          "id": "google/gemini-2.5-pro",
          "name": "Google: Gemini 2.5 Pro (Vertex)",
          "api": "google-vertex",
          "reasoning": true,
          "input": ["text", "image"],
          "cost": { "input": 1.25, "output": 10.0, "cacheRead": 0.125, "cacheWrite": 0 },
          "contextWindow": 1048576,
          "maxTokens": 65536
        },
        {
          "id": "google/gemini-2.5-flash",
          "name": "Google: Gemini 2.5 Flash (Vertex)",
          "api": "google-vertex",
          "reasoning": true,
          "input": ["text", "image"],
          "cost": { "input": 0.3, "output": 2.5, "cacheRead": 0.03, "cacheWrite": 0 },
          "contextWindow": 1048576,
          "maxTokens": 65536
        }
      ]
    }
  }
}
```

## Available models

Both bare IDs and prefixed IDs work:

| Model | Pi Bare ID | Hermes / Prefixed ID | Context | Max Output | Reasoning |
| --- | --- | --- | --- | --- | --- |
| Gemini 3.8 Flash | `gemini-3.8-flash` | `google/gemini-3.8-flash` | 1.0M | 65.5K | Yes |
| Gemini 3.7 Flash | `gemini-3.7-flash` | `google/gemini-3.7-flash` | 1.0M | 65.5K | Yes |
| Gemini 3.6 Flash | `gemini-3.6-flash` | `google/gemini-3.6-flash` | 1.0M | 65.5K | Yes |
| Gemini 3.5 Flash | `gemini-3.5-flash` | `google/gemini-3.5-flash` | 1.0M | 65.5K | Yes |
| Gemini 3.1 Pro Preview | `gemini-3.1-pro-preview` | `google/gemini-3.1-pro-preview` | 1.0M | 65.5K | Yes |
| Gemini 3 Flash Preview | `gemini-3-flash-preview` | `google/gemini-3-flash-preview` | 1.0M | 65.5K | Yes |
| Gemini 2.5 Pro | `gemini-2.5-pro` | `google/gemini-2.5-pro` | 1.0M | 65.5K | Yes |
| Gemini 2.5 Flash | `gemini-2.5-flash` | `google/gemini-2.5-flash` | 1.0M | 65.5K | Yes |

Note on region: keep `GOOGLE_CLOUD_LOCATION="global"`. Gemini 3.x preview models are served globally. Regional locations like `us-central1` can return 404 for preview models.

## Verification

Check provider readiness:

```bash
pi auth check --provider google-vertex
```

Expected output: `ready`.

List all models exposed by the provider:

```bash
pi --list-models google-vertex
```

Run a test prompt with the default bare model ID:

```bash
pi --model google-vertex/gemini-2.5-flash -p "Say 'Vertex ADC works' and nothing else"
```

Run a test prompt with the Hermes-style prefixed model ID:

```bash
pi --model google-vertex/google/gemini-3.8-flash -p "Say 'Vertex ADC works' and nothing else"
```

Both should return the expected phrase without warnings.

## Troubleshooting

### "Vertex AI requires a project ID"

This error means the project ID was not found in `auth.json` or `process.env`. Check that `~/.pi/agent/auth.json` has `GOOGLE_CLOUD_PROJECT` in its `env` dictionary, or export `GOOGLE_CLOUD_PROJECT` in your shell. Also verify that you did not set a dummy `key` property in `auth.json`.

### "Provider google-vertex is not ready: credentials_not_configured"

Pi did not find valid credentials. Confirm that `~/.config/gcloud/application_default_credentials.json` exists. If missing or expired, re-run `gcloud auth application-default login`.

### 404 Not Found on Gemini 3.x models

Verify that `GOOGLE_CLOUD_LOCATION` is set to `global`. Preview models are not published on all regional endpoints.

### 403 Forbidden / Permission Denied

The identity logged into gcloud lacks access to the GCP project. Grant the `roles/aiplatform.user` IAM role to your account in the Google Cloud Console or via gcloud:

```bash
gcloud projects add-iam-policy-binding YOUR_PROJECT_ID \
  --member="user:your-email@example.com" \
  --role="roles/aiplatform.user"
```
