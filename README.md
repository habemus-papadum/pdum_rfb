# Repository Coverage

[Full report](https://htmlpreview.github.io/?https://github.com/habemus-papadum/pdum_rfb/blob/python-coverage-comment-action-data/htmlcov/index.html)

| Name                                  |    Stmts |     Miss |   Cover |   Missing |
|-------------------------------------- | -------: | -------: | ------: | --------: |
| src/pdum/rfb/\_\_init\_\_.py          |       29 |        6 |     79% |94-96, 98-100, 102-104 |
| src/pdum/rfb/adaptive.py              |       42 |        2 |     95% |    73, 76 |
| src/pdum/rfb/auth.py                  |       14 |        0 |    100% |           |
| src/pdum/rfb/benchmark.py             |      240 |      151 |     37% |62, 143-144, 198-216, 244-290, 322-371, 387-391, 411-416, 420-421, 425-428, 434-540, 544 |
| src/pdum/rfb/cli.py                   |      158 |       75 |     53% |35-37, 70, 105-106, 113-114, 132-133, 147-148, 162-163, 170, 172, 174, 178, 182-194, 199-208, 221-300, 304 |
| src/pdum/rfb/display.py               |      149 |       15 |     90% |47, 50-51, 138-139, 147-152, 201, 209, 228-229 |
| src/pdum/rfb/encoders/\_\_init\_\_.py |        4 |        0 |    100% |           |
| src/pdum/rfb/encoders/base.py         |       33 |       13 |     61% |36-38, 43-45, 50-52, 91-106 |
| src/pdum/rfb/encoders/image.py        |       40 |        2 |     95% |    35, 73 |
| src/pdum/rfb/encoders/nvenc.py        |       85 |       39 |     54% |52, 54, 87-88, 106-107, 131-136, 145-173, 183-209 |
| src/pdum/rfb/encoders/nvenc\_cuda.py  |       78 |       78 |      0% |    26-176 |
| src/pdum/rfb/encoders/pyav\_h264.py   |       82 |        5 |     94% |37, 99, 152, 167, 172 |
| src/pdum/rfb/gpu.py                   |      148 |      101 |     32% |93-99, 142-145, 153, 162-164, 175-189, 198-203, 208-209, 228-244, 269-280, 296, 299-303, 306, 309, 322-352, 371-378 |
| src/pdum/rfb/metrics.py               |       42 |        0 |    100% |           |
| src/pdum/rfb/protocol.py              |       66 |        4 |     94% |67, 104, 125, 131 |
| src/pdum/rfb/server.py                |      172 |       66 |     62% |91, 98, 108-109, 132-134, 152-154, 190-191, 207-208, 217-218, 299, 307-356, 360-389, 393 |
| src/pdum/rfb/session.py               |      129 |        7 |     95% |114, 116-117, 177, 195-197 |
| src/pdum/rfb/sources.py               |       81 |        8 |     90% |102-105, 126-127, 130, 175 |
| src/pdum/rfb/transport.py             |       16 |        1 |     94% |        52 |
| src/pdum/rfb/types.py                 |       44 |        0 |    100% |           |
| **TOTAL**                             | **1652** |  **573** | **65%** |           |


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