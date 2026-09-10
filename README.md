# Playlist Mode

A faster way to build Spotify playlists. Pick the playlist you're building once, then every song is one tap.

Most playlists get built from other playlists, from what you've been listening to, or from a list in your head. In Spotify each of those means the same thing: open the three-dot menu on a song, choose "Add to playlist," scroll to find the right one, repeat. Playlist Mode makes the destination a mode you switch on, so adding is a single tap from anywhere: search, your own playlists, recent plays, your artists, recommendations, or a pasted list of song names. You review what you've added, then publish it to Spotify in one go.

## What it does

- **Start by choosing.** Create a new playlist (made in Spotify right away) or pick an existing one.
- **Search the whole catalog.** Songs and artists, with a plus on every row.
- **Browse your own library.** Your playlists, recently played, and your most-saved artists, with select-all and artist filters for grabbing a batch.
- **Recommended for you.** Picks built from the artists already in the playlist, your last 50 plays, your top tracks, and popular songs from the playlist's main artists.
- **Add a list.** Paste song names the way you'd text them ("dynamite by bts, bittersweet - keshi"), confirm the matches, add them all.
- **Review, then publish.** Reorder, remove, resolve duplicates, undo. Nothing touches Spotify until you publish.
- **Edit the playlist in place.** Name, description, cover image, and public/private visibility, right in the header.

## Running it

Live: https://oscarcheungg.github.io/playlistmode/ (login is limited to allowlisted Spotify accounts while the app is in development mode; ask to be added).

Locally, requires Node 18+ and a Spotify developer app with `http://127.0.0.1:8888/callback` as a redirect URI. The client ID is set in `app/spotify.js`.

```bash
node app/server.mjs
```

Then open http://127.0.0.1:8888 and log in with Spotify. The app reads your playlists once and caches them in the browser.

The Spotify app is in development mode, which limits login to allowlisted accounts.

## Notes on the Spotify API

Built against the current endpoints, which differ from most older examples: playlist creation is `POST /me/playlists`, playlist contents live at `/playlists/{id}/items`, search is capped at 10 results per call, and the recommendations, audio-features, and artist top-tracks endpoints are not available to new apps. The recommender and artist pages work around those limits with search.

## Author

Oscar Cheung. Builds on an earlier solo concept, [Spotify Playlists Enhanced](https://www.oscarcheung.com/spotify).
