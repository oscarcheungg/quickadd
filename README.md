# Quick Add

A faster way to build Spotify playlists from the music you already have.

Most playlists get built from other playlists. In Spotify that means opening a playlist, tapping the three-dot menu on a song, choosing "Add to playlist," scrolling to find the right one, and repeating for every song. Quick Add puts your whole library on one screen: pick the playlist you're building once, then select songs from any of your playlists, what's playing now, your recent plays, or search, and move them over in batches. Publish writes the result straight to Spotify.

## Status

Early build. Works against the author's own Spotify account (the Spotify app is in development mode, which limits login to allowlisted accounts).

## Running it

Requires Node 18+ and a Spotify developer app with `http://127.0.0.1:8888/callback` as a redirect URI.

```bash
cd app
SPOTIFY_CLIENT_ID=your_client_id node smoke.mjs
```

The smoke test logs in, reads your playlists, creates a private test playlist, and adds the currently playing track to it. It uses the current Spotify Web API endpoints (`/me/playlists`, `/playlists/{id}/items`).

## Author

Oscar Cheung. Builds on an earlier solo concept, [Spotify Playlists Enhanced](https://www.oscarcheung.com/spotify).
