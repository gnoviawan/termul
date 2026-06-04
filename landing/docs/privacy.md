# Landing Privacy Notes

## Testimonial fallback avatars

The testimonials section displays submitted names on the page, but fallback avatar
generation does not send those raw names to DiceBear. When a testimonial does not
provide an avatar image, the browser computes a SHA-256 hash of the displayed
name and uses only that hash-derived seed in the DiceBear avatar URL.

If browser hashing is unavailable, the page shows local initials instead of
requesting a remote fallback avatar.
