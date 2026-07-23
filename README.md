# RURP Chat Bot

AI chat bot powered by Mistral. Works in designated channels only.

## Environment Variables

| Variable | Description |
|---|---|
| `DISCORD_TOKEN` | Bot token |
| `MISTRAL_API_KEY` | Mistral AI API key |

## Commands (owner only)

| Command | Description |
|---|---|
| `.toggle on` | Enable bot responses |
| `.toggle off` | Disable bot responses |
| `.sync` | Sync last 200 messages from every channel for server context |

## Allowed Channels

- `1529866897317822544`
- `1528332597036322907`

## Hosting

Deployed on Render. The bot exposes an HTTP server on `PORT` for uptime pings.
