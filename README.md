# Plato Explorer

Explore how articles in the Stanford Encyclopedia of Philosophy mention people and ideas. Larger nodes receive more mentions. Thicker lines mean more mentions between a pair. You can also search the full text and read articles in the explorer.

![The home screen with the encyclopedia network and no node selected](docs/screenshots/home.png)

Select **Love** to see its 164 neighbours under the default filters. The sidebar shows mentions in both directions and identifies articles the SEP lists as related entries.

![Love selected on a laptop, with default filters and the article details sidebar open](docs/screenshots/love.png)

Select **Music** and find **Confucius** in the sidebar. Choose **Mentions** to see the 18 passages where the Confucius entry mentions music. Selecting a passage takes you to that sentence in the article.

![The Music network with the Confucius Mentions sidebar open, showing article passages and highlighting the matched words](docs/screenshots/music.png)

The brief excerpts in these screenshots are from the _Stanford Encyclopedia of Philosophy_. [“Love” by Bennett Helm](https://plato.stanford.edu/entries/love/) · [“Confucius” by Mark Csikszentmihalyi](https://plato.stanford.edu/entries/confucius/)

## Run locally

From a clone of this repository, use Python 3.12 or newer. The download is about 271 MB. One snapshot supplies the articles and their related entries. The other supplies author credits. [Article dataset](https://huggingface.co/datasets/hugfaceguy0001/stanford_plato) · [Author credit dataset](https://huggingface.co/datasets/dmarx/stanford-encyclopedia-of-philosophy_dec23)

```sh
python3 -m venv .venv
. .venv/bin/activate
python -m pip install -r requirements.txt
python scripts/fetch_source.py
python scripts/build_data.py
python scripts/build_search.py
python scripts/serve.py
```

Open `http://127.0.0.1:5173` in your browser.

## Copyright

The repository contains no SEP articles or generated corpus files. Entry authors generally retain copyright in their articles. The Metaphysics Research Lab at Stanford University holds copyright in the encyclopedia. The MIT license covers the explorer code. [MIT license](LICENSE) · [Copyright notice](COPYRIGHT.md) · [SEP terms of use](https://plato.stanford.edu/info.html#terms)
