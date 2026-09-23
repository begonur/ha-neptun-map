# HA NEPTUN Map

Custom Home Assistant dashboard card for displaying the NEPTUN air-threat map of Ukraine.

> **Alpha software:** current version is `0.0.1-alpha.1`.

## Features

- Live NEPTUN air-threat data
- Oblast and district alert visualization
- Threat markers with clustering and predicted movement
- Kyiv city alert visualization
- Responsive layout for desktop and mobile
- Home Assistant light/dark theme support

## Installation with HACS

1. Open HACS in Home Assistant.
2. Add this repository as a custom repository.
3. Select **Dashboard** as the repository type.
4. Install **HA NEPTUN Map**.
5. Refresh the browser or restart the Home Assistant frontend if required.

## Lovelace

Add the card to a dashboard:

```yaml
type: custom:ha-neptun-map
```

## Data source

Live air-threat data is provided by [NEPTUN](https://neptun.in.ua/).

This project is an independent Home Assistant frontend card and is not an official NEPTUN or Home Assistant project.
