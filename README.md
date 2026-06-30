# Repository Coverage

[Full report](https://htmlpreview.github.io/?https://github.com/habemus-papadum/pdum_rfb/blob/python-coverage-comment-action-data/htmlcov/index.html)

| Name                                      |    Stmts |     Miss |   Cover |   Missing |
|------------------------------------------ | -------: | -------: | ------: | --------: |
| src/pdum/rfb/\_\_init\_\_.py              |       29 |        6 |     79% |96-98, 100-102, 104-106 |
| src/pdum/rfb/adaptive.py                  |       50 |        2 |     96% |    85, 88 |
| src/pdum/rfb/asgi.py                      |       71 |        8 |     89% |83-85, 103-107, 113-114 |
| src/pdum/rfb/auth.py                      |       16 |        0 |    100% |           |
| src/pdum/rfb/benchmark.py                 |      240 |      151 |     37% |62, 143-144, 198-216, 244-290, 322-371, 387-391, 411-416, 420-421, 425-428, 434-540, 544 |
| src/pdum/rfb/cli.py                       |      158 |       75 |     53% |35-37, 70, 105-106, 117-118, 136-137, 151-152, 166-167, 174, 176, 178, 182, 186-198, 203-212, 225-304, 308 |
| src/pdum/rfb/display.py                   |      165 |       15 |     91% |47, 50-51, 140-141, 149-154, 203, 248-249, 325 |
| src/pdum/rfb/encoders/\_\_init\_\_.py     |        4 |        0 |    100% |           |
| src/pdum/rfb/encoders/base.py             |       37 |       15 |     59% |36-38, 43-45, 50-52, 58-60, 103-118 |
| src/pdum/rfb/encoders/h264\_cpu.py        |       84 |        5 |     94% |37, 99, 163, 178, 183 |
| src/pdum/rfb/encoders/image.py            |       42 |        2 |     95% |    35, 83 |
| src/pdum/rfb/encoders/nvenc\_cpu.py       |       85 |       39 |     54% |52, 54, 87-88, 106-107, 131-136, 145-173, 183-209 |
| src/pdum/rfb/encoders/nvenc\_gpu\_pdum.py |      103 |       82 |     20% |41-44, 69-92, 105-117, 120-131, 136, 139-142, 145-146, 151, 175-190, 195-220 |
| src/pdum/rfb/encoders/nvenc\_gpu\_pyav.py |       78 |       78 |      0% |    26-176 |
| src/pdum/rfb/gpu.py                       |      153 |      103 |     33% |93-99, 142-145, 153, 162-164, 175-189, 198-203, 208-209, 228-244, 269-280, 296, 299, 305, 309-313, 316, 319, 332-362, 381-388 |
| src/pdum/rfb/metrics.py                   |       42 |        0 |    100% |           |
| src/pdum/rfb/protocol.py                  |       66 |        4 |     94% |67, 104, 125, 131 |
| src/pdum/rfb/rendercanvas.py              |       61 |        3 |     95% |131, 152, 188 |
| src/pdum/rfb/server.py                    |      271 |       75 |     72% |136, 149-151, 164-165, 203-205, 223-225, 264, 283-284, 398, 403, 410, 420, 431, 441, 490-491, 627, 633-684, 688-731, 735 |
| src/pdum/rfb/session.py                   |      164 |        5 |     97% |134, 136-137, 273, 292 |
| src/pdum/rfb/sources.py                   |       81 |        8 |     90% |102-105, 128-129, 132, 177 |
| src/pdum/rfb/transport.py                 |       16 |        0 |    100% |           |
| src/pdum/rfb/types.py                     |       44 |        0 |    100% |           |
| **TOTAL**                                 | **2060** |  **676** | **67%** |           |


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