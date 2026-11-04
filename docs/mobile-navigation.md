# Mobile navigation

When changing the graph or reader, check the behavior below on a narrow touch viewport. [App state and controls](../web/app.js), [history](../web/navigation.js), [reader](../web/reader.js), [evidence](../web/evidence.js) and [responsive styles](../web/styles.css).

## Requirements

- The mobile graph fills the viewport. Details and Filters open full screen with a single-tap return to the graph. The graph heading and bottom counts stay hidden. Legend belongs beside the zoom controls. Search uses at least 16px text and supports normal browser zoom. Reader text wraps without overflow at 320px.
- Details uses `#inspector-scroll` for connections and the About & copyright footer. The footer scrolls with the content. Capture, restore and listeners use this same owner.
- History restores selection, panels, Mentions, reader location/highlight, filters, search, display mode, camera and scroll. Capture the reader before dismissing it for an internal mention. Back/Forward must work after sustained scrolling.
- Mentions uses article UTF-16 offsets to highlight the exact sentence and destination mentions while preserving links. Opening a passage scrolls the match into view. Back returns to Mentions.
- Mobile Contents moves the existing `#reader-toc` into `#reader-contents-dialog`. Opening, scrolling and dismissing it preserve reading position and history. Selecting a section closes it and adds one entry. Back restores the previous passage. Desktop retains its contents column.
- The [manifest](../web/manifest.webmanifest), Apple metadata and icons support Home Screen installation and standalone display. The app loads its corpus over the network. See [public deployment](public-deployment.md).

## History guard

Per-scroll `history.replaceState()` calls caused a reproducible WebKit `SecurityError` after more than 100 calls within 10 seconds. Connected-node and Back handlers then failed when attempting another history write.

`NavigationHistory.save()` updates memory, debouncing session-storage persistence by 250 ms. Navigation/page exit flush pending snapshots. Only navigation and initialization write browser history. Restoration reads the latest cached position. The snapshot in the browser history entry can be older. Preserve the zero-history-writes regression in [navigation tests](../tests/navigation.test.js), independently of browser rate limits.

## Manual acceptance

Run `npm start` with generated data present. Use touch at 390×844 and 320×844, rotate once to 844×390, and check desktop at 1440px. Wait for any existing smooth-scroll animation to settle before comparing positions.

| Action                                                                                                                                     | Expected result                                                                                                                                     |
| ------------------------------------------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------- |
| Open the graph, focus search and open Details, Filters and Legend.                                                                         | Full viewport graph, readable controls, no input-induced page zoom and a single tap to open or close each panel.                                    |
| Select a node, open Details, tap a connected node, reopen Details, then Back to graph. Repeat quickly.                                     | The selected network changes and the return works without repeated taps.                                                                            |
| In Plato Details, scroll continuously for at least 10 seconds, reach the footer, then tap a connection or Back.                            | The footer scrolls away. The first tap works and no history `SecurityError` occurs.                                                                 |
| Change and reset Filters, switch between List and Network, show more entries, then use browser Back/Forward.                               | Controls respond once. Restored views retain the appropriate filters, mode and list position.                                                       |
| Select a keyword, open Details and tap Mentions beside a connected article. Open a passage. Tap a highlighted internal mention, then Back. | The matching sentence is highlighted and its mention links remain active. Successive Back actions restore the reader passage and the Mentions list. |
| Read Kant, scroll midway, open Contents, scroll its list, then dismiss separately with Close, Escape and the backdrop.                     | The article stays open at the same pixel position. Its URL and history position/length stay unchanged.                                              |
| From that position, choose a later section and use Back/Forward.                                                                           | One additional history entry records the section. Back restores the original reading position and Forward restores the section.                     |
| Rotate with Contents open, then close and reopen it. Check desktop contents navigation.                                                    | Overlay remains usable in landscape. Desktop section links remain available in the contents column.                                                 |
| Scroll the reader for at least 10 seconds, tap Back once, then Forward. Reload while reading.                                              | The reader closes on the first tap. Forward and reload restore the latest saved reading position.                                                   |
| On an iPhone, Safari → Share → Add to Home Screen → Open as Web App, if offered. Launch Plato.                                             | Correct icon/name, standalone window and usable controls around safe areas.                                                                         |

## Verification limits

Touch-enabled Chromium and WebKit checks passed at 390px/320px for controls and history. WebKit verified sustained scripted scrolling without history writes, exact scroll restoration, Contents dismissal/jump/Back, desktop contents and one rotation. [Evidence tests](../tests/evidence.test.js) cover exact offsets and preserved links. Navigation tests cover cached positions, reload, unavailable storage and the scroll-write guard. [Public asset tests](../tests/public-assets.test.js) check staged manifest/icon assets.

Physical iPhone keyboard zoom, pinch/inertial gestures, safe areas, native pickers and Home Screen installation remain unverified. Check these on-device. The automated select tests chose values through the browser API.
