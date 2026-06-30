# Repository Coverage

[Full report](https://htmlpreview.github.io/?https://github.com/habemus-papadum/pdum_rfb/blob/python-coverage-comment-action-data/htmlcov/index.html)

| Name                                  |    Stmts |     Miss |   Cover |   Missing |
|-------------------------------------- | -------: | -------: | ------: | --------: |
| src/pdum/rfb/\_\_init\_\_.py          |       24 |        4 |     83% |85-87, 89-91 |
| src/pdum/rfb/adaptive.py              |       42 |        2 |     95% |    73, 76 |
| src/pdum/rfb/auth.py                  |       14 |        0 |    100% |           |
| src/pdum/rfb/benchmark.py             |      143 |       58 |     59% |62, 143-144, 198-216, 243-248, 252-253, 257-325, 329 |
| src/pdum/rfb/display.py               |      134 |        5 |     96% |116, 172, 180, 199-200 |
| src/pdum/rfb/encoders/\_\_init\_\_.py |        4 |        0 |    100% |           |
| src/pdum/rfb/encoders/base.py         |       29 |       11 |     62% |36-38, 43-45, 80-95 |
| src/pdum/rfb/encoders/image.py        |       40 |        2 |     95% |    35, 73 |
| src/pdum/rfb/encoders/nvenc.py        |       85 |       39 |     54% |52, 54, 87-88, 106-107, 131-136, 145-173, 183-209 |
| src/pdum/rfb/encoders/pyav\_h264.py   |       82 |        5 |     94% |37, 99, 152, 167, 172 |
| src/pdum/rfb/metrics.py               |       42 |        0 |    100% |           |
| src/pdum/rfb/protocol.py              |       66 |        4 |     94% |67, 104, 125, 131 |
| src/pdum/rfb/server.py                |      151 |       58 |     62% |40-42, 47-50, 90, 112-114, 163-164, 180-181, 190-191, 264, 272-309, 313-337, 341 |
| src/pdum/rfb/session.py               |      129 |        7 |     95% |114, 116-117, 177, 195-197 |
| src/pdum/rfb/sources.py               |       81 |        8 |     90% |102-105, 126-127, 130, 175 |
| src/pdum/rfb/transport.py             |       16 |        1 |     94% |        52 |
| src/pdum/rfb/types.py                 |       44 |        0 |    100% |           |
| **TOTAL**                             | **1126** |  **204** | **82%** |           |


## Setup coverage badge

Below are examples of the badges you can use in your main branch `README` file.

### Direct image

[![Coverage badge](https://raw.githubusercontent.com/habemus-papadum/pdum_rfb/python-coverage-comment-action-data/badge.svg)](https://htmlpreview.github.io/?https://github.com/habemus-papadum/pdum_rfb/blob/python-coverage-comment-action-data/htmlcov/index.html)

This is the one to use if your repository is private or if you don't want to customize anything.

### [Shields.io](https://shields.io) Json Endpoint

[![Coverage badge](https://img.shields.io/endpoint?url=https://raw.githubusercontent.com/habemus-papadum/pdum_rfb/python-coverage-comment-action-data/endpoint.json)](https://htmlpreview.github.io/?https://github.com/habemus-papadum/pdum_rfb/blob/python-coverage-comment-action-data/htmlcov/index.html)

Using this one will allow you to [customize](https://shields.io/endpoint) the look of your badge.
It won't work with private repositories. It won't be refreshed more than once per five minutes.

### [Shields.io](https://shields.io) Dynamic Badge

[![Coverage badge](https://img.shields.io/badge/dynamic/json?color=brightgreen&label=coverage&query=%24.message&url=https%3A%2F%2Fraw.githubusercontent.com%2Fhabemus-papadum%2Fpdum_rfb%2Fpython-coverage-comment-action-data%2Fendpoint.json)](https://htmlpreview.github.io/?https://github.com/habemus-papadum/pdum_rfb/blob/python-coverage-comment-action-data/htmlcov/index.html)

This one will always be the same color. It won't work for private repos. I'm not even sure why we included it.

## What is that?

This branch is part of the
[python-coverage-comment-action](https://github.com/marketplace/actions/python-coverage-comment)
GitHub Action. All the files in this branch are automatically generated and may be
overwritten at any moment.