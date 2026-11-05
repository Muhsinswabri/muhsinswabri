# Muhsin Swabri – Portfolio

A single-page portfolio: an interactive 3D avatar hero (Three.js), About, Technologies & Tools,
Connect With Me, Projects, What I Do and a working contact form.

## Structure

| Path | What it is |
| --- | --- |
| `index.html` | The whole page: markup, styles and page scripts |
| `avatar3d.js`, `avatar-portrait-rig.js` | The live avatar (Three.js is lazy-loaded from a CDN) |
| `avatar-glb-rig.js` | Optional rig for a future modelled avatar (`data-model` on `#avatar3d`) |
| `images/` | Avatar cut-out, its source render, and project screenshots |
| `api/contact.js` | Serverless function that emails contact-form messages |
| `tools/prepare_avatar.py` | Rebuilds the avatar cut-out from its source render |

No build step: the site is static files plus one serverless function.

## Run locally

```bash
python -m http.server 8765
```

Open http://127.0.0.1:8765. The contact form needs the serverless function, so to test it
locally use `npx vercel dev` with the environment variables below.

## Contact form email

`api/contact.js` sends each message to `swabri2004@gmail.com` through [Resend](https://resend.com),
with the visitor's address as Reply-To. Set these in Vercel (Project → Settings → Environment
Variables), never in the page:

| Variable | Required | Purpose |
| --- | --- | --- |
| `RESEND_API_KEY` | yes | Resend API key (secret) |
| `CONTACT_TO_EMAIL` | no | Recipient, default `swabri2004@gmail.com` |
| `CONTACT_FROM_EMAIL` | no | Sender; default is Resend's test sender, which only delivers to the Resend account's own address. Verify a domain in Resend to use your own. |
| `ALLOWED_ORIGIN` | no | Only accept submissions from this origin |

Without `RESEND_API_KEY` the endpoint answers 503 and the form tells visitors to email directly.

## Deploy

Vercel, framework preset "Other", root directory `./`, no build command, output directory `./`.
Pushes to `main` deploy to production.
