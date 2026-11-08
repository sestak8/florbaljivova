# Websites

Two static websites (plain HTML + CSS, no build step):

| Folder | What it is | Final address |
|---|---|---|
| `jirisestak/` | Personal page | https://www.jirisestak.com |
| `florbaljivova/` | Floorball tournament | https://www.florbaljivova.cz (and www.jirisestak.com/florbaljivova redirects there) |

## How the two addresses work

GitHub Pages does this out of the box with **two repositories**:

1. **`<username>.github.io`**: the contents of `jirisestak/`. Custom domain: `www.jirisestak.com`.
2. **`florbaljivova`**: the contents of `florbaljivova/`. Custom domain: `www.florbaljivova.cz`.

A project repository is automatically served under the user site's path, so
`www.jirisestak.com/florbaljivova` works and GitHub redirects it to
`www.florbaljivova.cz`. No extra configuration is needed.

## Steps to publish

1. Create a free account on https://github.com.
2. Create the two repositories above (Public) and upload the files of each folder
   to the **root** of its repository.
3. In each repository: **Settings → Pages → Source: Deploy from a branch → `main` / root**.
   The site goes live at `https://<username>.github.io` (and `/florbaljivova`).
4. Buy the domains (for example at Wedos, Forpsi or Cloudflare).
5. At the domain registrar, set DNS for each domain:
   - `www` → **CNAME** → `<username>.github.io`
   - root domain (`@`) → **A** records `185.199.108.153`, `185.199.109.153`,
     `185.199.110.153`, `185.199.111.153`
6. In **Settings → Pages → Custom domain** enter `www.jirisestak.com` (or
   `www.florbaljivova.cz`), wait for the check, then tick **Enforce HTTPS**.

## Editing content

Places to fill in are marked with `<!-- DOPLNIT -->` comments in the HTML.

- **News**: copy an `<li>…</li>` block in `novinky.html` and put it at the top.
- **History**: add a year to the timeline and to the winners table in `historie.html`.
- **Gallery**: put photos into `florbaljivova/img/<year>/` and follow the
  instructions at the top of `galerie.html`.
- **Styles**: shared in `florbaljivova/css/style.css`. The accent colour is
  `--accent` at the top of the file.
