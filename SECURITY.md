# Security Policy

## Supported Versions

We actively release security updates for the latest major version of MindWeave. 

| Version | Supported          |
| ------- | ------------------ |
| Main    | :white_check_mark: |

---

## Reporting a Vulnerability

The security of your local environment and API credentials is a top priority. If you discover a potential security flaw, credential leak bug, or vulnerability in MindWeave, **please do not report it through a public GitHub Issue or Discussion.**

Instead, please report vulnerabilities using one of the following methods:

1. **GitHub Private Vulnerability Reporting:**
   Navigate to the **Security** tab of this repository ➔ **Vulnerabilities** ➔ Click **"Report a vulnerability"**.

2. **Direct Contact:**
   If private reporting is unavailable, reach out directly to the maintainer via email or private channels.

### What to Include in Your Report

To help us investigate and patch the issue quickly, please include:
* A detailed description of the vulnerability and its potential impact.
* Step-by-step instructions or a Minimal Working Example (MWE) to reproduce the behavior.
* The operating system, terminal environment, and driver/model provider involved.
* Any relevant (sanitized) logs—ensure all private API keys, tokens, or system paths are redacted.

---

## Secrets & Local Data Safety Guidelines

MindWeave is a terminal-native tool that interacts with external APIs and local workspaces. We ask contributors and users to follow these safety principles:

* **API Keys & Credentials:** MindWeave reads keys from local environment variables or sanitized configuration files. Never commit private keys, session tokens, or `.env` files into pull requests.
* **Log Sanitization:** Ensure debug logs submitted during PRs or issue reports do not leak authorization headers, full prompt outputs containing confidential code, or local system paths.
* **Model Execution Boundaries:** MindWeave core orchestration isolates tool execution loops. If you notice a driver bypassing local command approval boundaries, report it immediately as a high-priority bug.

---

## Response Timeline

* **Initial Acknowledgment:** Within 48 hours of receiving a vulnerability report.
* **Status Update:** Regular updates on the patch progress until a fix is deployed to `main`.
