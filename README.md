# Repository Coverage

[Full report](https://htmlpreview.github.io/?https://github.com/habemus-papadum/pdum_rfb/blob/python-coverage-comment-action-data/htmlcov/index.html)

| Name                                      |    Stmts |     Miss |   Cover |   Missing |
|------------------------------------------ | -------: | -------: | ------: | --------: |
| src/pdum/rfb/\_\_init\_\_.py              |       29 |        6 |     79% |94-96, 98-100, 102-104 |
| src/pdum/rfb/adaptive.py                  |       42 |        2 |     95% |    73, 76 |
| src/pdum/rfb/auth.py                      |       14 |        0 |    100% |           |
| src/pdum/rfb/benchmark.py                 |      240 |      151 |     37% |62, 143-144, 198-216, 244-290, 322-371, 387-391, 411-416, 420-421, 425-428, 434-540, 544 |
| src/pdum/rfb/cli.py                       |      158 |       75 |     53% |35-37, 70, 105-106, 117-118, 136-137, 151-152, 166-167, 174, 176, 178, 182, 186-198, 203-212, 225-304, 308 |
| src/pdum/rfb/display.py                   |      152 |       15 |     90% |47, 50-51, 138-139, 147-152, 201, 209, 228-229 |
| src/pdum/rfb/encoders/\_\_init\_\_.py     |        4 |        0 |    100% |           |
| src/pdum/rfb/encoders/base.py             |       37 |       15 |     59% |36-38, 43-45, 50-52, 58-60, 103-118 |
| src/pdum/rfb/encoders/h264\_cpu.py        |       82 |        5 |     94% |37, 99, 152, 167, 172 |
| src/pdum/rfb/encoders/image.py            |       40 |        2 |     95% |    35, 73 |
| src/pdum/rfb/encoders/nvenc\_cpu.py       |       85 |       39 |     54% |52, 54, 87-88, 106-107, 131-136, 145-173, 183-209 |
| src/pdum/rfb/encoders/nvenc\_gpu\_pdum.py |      101 |       81 |     20% |41-44, 69-92, 105-117, 120-131, 134-137, 140-141, 146, 170-185, 190-215 |
| src/pdum/rfb/encoders/nvenc\_gpu\_pyav.py |       78 |       78 |      0% |    26-176 |
| src/pdum/rfb/gpu.py                       |      148 |      101 |     32% |93-99, 142-145, 153, 162-164, 175-189, 198-203, 208-209, 228-244, 269-280, 296, 299-303, 306, 309, 322-352, 371-378 |
| src/pdum/rfb/metrics.py                   |       42 |        0 |    100% |           |
| src/pdum/rfb/protocol.py                  |       66 |        4 |     94% |67, 104, 125, 131 |
| src/pdum/rfb/rendercanvas.py              |       61 |        5 |     92% |131, 152, 156, 159, 188 |
| src/pdum/rfb/server.py                    |      175 |       68 |     61% |91, 104-106, 119-120, 143-145, 163-165, 201-202, 218-219, 228-229, 311, 319-368, 372-401, 405 |
| src/pdum/rfb/session.py                   |      129 |        7 |     95% |118, 120-121, 181, 199-201 |
| src/pdum/rfb/sources.py                   |       81 |        8 |     90% |102-105, 128-129, 132, 177 |
| src/pdum/rfb/transport.py                 |       16 |        1 |     94% |        52 |
| src/pdum/rfb/types.py                     |       44 |        0 |    100% |           |
| **TOTAL**                                 | **1824** |  **663** | **64%** |           |


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