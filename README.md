# Repository Coverage

[Full report](https://htmlpreview.github.io/?https://github.com/habemus-papadum/pdum_rfb/blob/python-coverage-comment-action-data/htmlcov/index.html)

| Name                                      |    Stmts |     Miss |   Cover |   Missing |
|------------------------------------------ | -------: | -------: | ------: | --------: |
| src/pdum/rfb/\_\_init\_\_.py              |       30 |        6 |     80% |100-102, 104-106, 108-110 |
| src/pdum/rfb/adaptive.py                  |       50 |        2 |     96% |    85, 88 |
| src/pdum/rfb/asgi.py                      |       71 |        8 |     89% |83-85, 103-107, 113-114 |
| src/pdum/rfb/auth.py                      |       16 |        0 |    100% |           |
| src/pdum/rfb/benchmark.py                 |      240 |      151 |     37% |62, 143-144, 198-216, 244-290, 322-371, 387-391, 411-416, 420-421, 425-428, 434-543, 547 |
| src/pdum/rfb/cli.py                       |      176 |       91 |     48% |35-37, 70, 105-106, 117-118, 136-137, 151-152, 166-167, 174, 176, 178, 182, 186-198, 203-212, 225-304, 321-351, 355 |
| src/pdum/rfb/demo\_app.py                 |      104 |       19 |     82% |113-114, 119-120, 124-135, 140, 153, 155 |
| src/pdum/rfb/demo\_tui.py                 |      211 |       82 |     61% |52-53, 60, 62, 64, 66, 72-78, 112-113, 115-118, 128-136, 141-150, 155-162, 166-167, 172, 194-243, 267, 296 |
| src/pdum/rfb/demos.py                     |      119 |       17 |     86% |109-111, 116-117, 124, 136-140, 174-177, 199-208 |
| src/pdum/rfb/display.py                   |      205 |       30 |     85% |47, 50-51, 61, 64-65, 159-160, 168-173, 175-182, 190-192, 239, 260, 263, 288, 292, 331-332, 408 |
| src/pdum/rfb/encoders/\_\_init\_\_.py     |        4 |        0 |    100% |           |
| src/pdum/rfb/encoders/base.py             |       44 |       13 |     70% |47-50, 55-58, 66-68, 75-77, 132-133, 145 |
| src/pdum/rfb/encoders/h264\_cpu.py        |       87 |        7 |     92% |37, 96-98, 103, 167, 182, 187 |
| src/pdum/rfb/encoders/image.py            |       45 |        4 |     91% |31-33, 39, 87 |
| src/pdum/rfb/encoders/nvenc\_cpu.py       |       85 |       39 |     54% |52, 54, 87-88, 106-107, 131-136, 145-173, 183-209 |
| src/pdum/rfb/encoders/nvenc\_gpu\_pdum.py |      114 |       92 |     19% |41-44, 70-102, 116-128, 131-144, 150-152, 157, 160-166, 169-170, 175, 199-214, 219-244 |
| src/pdum/rfb/encoders/nvenc\_gpu\_pyav.py |       78 |       78 |      0% |    26-176 |
| src/pdum/rfb/encoders/vtenc.py            |      116 |       91 |     22% |34-37, 46-56, 78-97, 100-110, 115-125, 128-137, 143-146, 149-155, 158-159, 164, 186-191, 196-210 |
| src/pdum/rfb/gpu.py                       |      153 |      103 |     33% |93-99, 142-145, 153, 162-164, 175-189, 198-203, 208-209, 228-244, 269-280, 296, 299, 305, 309-313, 316, 319, 332-362, 381-388 |
| src/pdum/rfb/metal.py                     |      103 |       74 |     28% |35-40, 49-51, 79-96, 105-107, 114-118, 138-158, 173-186, 192-202, 210-214, 229, 232, 235, 239, 242, 245 |
| src/pdum/rfb/metrics.py                   |       42 |        0 |    100% |           |
| src/pdum/rfb/notebook.py                  |       37 |        9 |     76% |    97-107 |
| src/pdum/rfb/protocol.py                  |       66 |        2 |     97% |   67, 131 |
| src/pdum/rfb/rendercanvas.py              |       61 |        3 |     95% |131, 152, 188 |
| src/pdum/rfb/server.py                    |      316 |       90 |     72% |146, 157-167, 174-177, 190-192, 239-241, 283-284, 307-314, 322, 324-325, 374-375, 492, 497, 504, 514, 525, 535, 584-585, 729, 735-786, 790-833, 837 |
| src/pdum/rfb/session.py                   |      188 |        6 |     97% |134, 136-137, 178, 318, 337 |
| src/pdum/rfb/sources.py                   |       81 |        8 |     90% |102-105, 128-129, 132, 177 |
| src/pdum/rfb/transport.py                 |       16 |        0 |    100% |           |
| src/pdum/rfb/types.py                     |       44 |        0 |    100% |           |
| **TOTAL**                                 | **2902** | **1025** | **65%** |           |


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