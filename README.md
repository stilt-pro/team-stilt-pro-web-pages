# team.stilt.pro — Team Hub

Internal web hub for the STILT shop. Serves resources, equipment docs, and
shop-floor links. Fully static — no backend, no build step. Hosted on Azure
Static Web Apps (free tier), no login (internal use only).

## Layout

```
.
├── index.html            Team Hub landing page
├── serial-numbers.html   Serial number lookup (talks to Microsoft Graph
│                         client-side via MSAL — no server component)
├── press-brake.html      Press brake operation / programs
└── .gitignore
```

## Deploy notes (Azure Static Web Apps)

The repo deploys straight to Azure Static Web Apps — no `api/` folder, no
build command, app location is the repo root (`/`), output location empty.
GitHub Actions (auto-generated when the Static Web App resource is linked to
this repo) rebuilds and redeploys on every push to `main`.

Custom domain: point `team.stilt.pro` at the Static Web App's default
hostname via CNAME (or use the TXT-verified apex/custom-domain flow if ever
moved to the bare `stilt.pro` domain), then add the domain in the Azure
Portal — a free managed TLS certificate is issued automatically.

## Conventions

- No auth — team hub is internal.
- `serial-numbers.html`'s SharePoint/Graph integration uses an Azure AD app
  registration with a redirect URI tied to this site's domain
  (`SP_CFG.clientId` / `tenantId` in that file). If the domain changes,
  update the redirect URI in the Azure AD app registration to match.
