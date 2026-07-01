# Repository Coverage

[Full report](https://htmlpreview.github.io/?https://github.com/habemus-papadum/pdum_rfb/blob/python-coverage-comment-action-data/htmlcov/index.html)

| Name                                      |    Stmts |     Miss |   Cover |   Missing |
|------------------------------------------ | -------: | -------: | ------: | --------: |
| src/pdum/rfb/\_\_init\_\_.py              |       30 |        6 |     80% |100-102, 104-106, 108-110 |
| src/pdum/rfb/adaptive.py                  |       50 |        2 |     96% |    85, 88 |
| src/pdum/rfb/asgi.py                      |       71 |        8 |     89% |83-85, 103-107, 113-114 |
| src/pdum/rfb/auth.py                      |       16 |        0 |    100% |           |
| src/pdum/rfb/benchmark.py                 |      283 |      192 |     32% |62, 143-144, 198-216, 244-290, 322-371, 404-448, 464-468, 474-477, 497-502, 506-507, 511-514, 520-650, 654 |
| src/pdum/rfb/cli.py                       |      205 |      102 |     50% |35-37, 70, 87, 91, 106-107, 118-119, 137-138, 152-153, 167-168, 180-181, 189-190, 196, 200, 202, 204, 208, 212-224, 229-238, 251-337, 354-384, 388 |
| src/pdum/rfb/demo\_app.py                 |      104 |       19 |     82% |113-114, 119-120, 124-135, 140, 153, 155 |
| src/pdum/rfb/demo\_tui.py                 |      211 |       82 |     61% |52-53, 60, 62, 64, 66, 72-78, 112-113, 115-118, 128-136, 141-150, 155-162, 166-167, 172, 194-243, 267, 296 |
| src/pdum/rfb/demos.py                     |      119 |       17 |     86% |109-111, 116-117, 124, 136-140, 174-177, 199-208 |
| src/pdum/rfb/display.py                   |      239 |       37 |     85% |48, 51-52, 62, 65-66, 185-186, 194-199, 201-208, 216-218, 251-256, 283-285, 320, 341, 344, 369, 373, 412-413, 489 |
| src/pdum/rfb/encoders/\_\_init\_\_.py     |        4 |        0 |    100% |           |
| src/pdum/rfb/encoders/base.py             |       44 |       13 |     70% |47-50, 55-58, 66-68, 75-77, 132-133, 145 |
| src/pdum/rfb/encoders/h264\_cpu.py        |       87 |        7 |     92% |37, 96-98, 103, 167, 182, 187 |
| src/pdum/rfb/encoders/image.py            |       45 |        4 |     91% |31-33, 39, 87 |
| src/pdum/rfb/encoders/nvenc\_cpu.py       |       85 |       39 |     54% |52, 54, 87-88, 106-107, 131-136, 145-173, 183-209 |
| src/pdum/rfb/encoders/nvenc\_gpu\_pdum.py |      132 |      108 |     18% |41-44, 57-60, 86-123, 137-149, 152-166, 172-178, 184-189, 194, 197-203, 206-207, 212, 236-251, 256-281 |
| src/pdum/rfb/encoders/nvenc\_gpu\_pyav.py |       78 |       78 |      0% |    26-176 |
| src/pdum/rfb/encoders/vtenc.py            |      118 |       92 |     22% |34-37, 46-56, 78-97, 100-110, 115-125, 128-137, 146, 152-155, 158-164, 167-168, 173, 195-200, 205-219 |
| src/pdum/rfb/gpu.py                       |      153 |      103 |     33% |93-99, 142-145, 153, 162-164, 175-189, 198-203, 208-209, 228-244, 269-280, 296, 299, 305, 309-313, 316, 319, 332-362, 381-388 |
| src/pdum/rfb/metal.py                     |      103 |       74 |     28% |35-40, 49-51, 79-96, 105-107, 114-118, 138-158, 173-186, 192-202, 210-214, 229, 232, 235, 239, 242, 245 |
| src/pdum/rfb/metrics.py                   |       42 |        0 |    100% |           |
| src/pdum/rfb/notebook.py                  |       37 |        9 |     76% |    97-107 |
| src/pdum/rfb/protocol.py                  |       66 |        2 |     97% |   67, 131 |
| src/pdum/rfb/rendercanvas.py              |       61 |        3 |     95% |131, 152, 188 |
| src/pdum/rfb/server.py                    |      316 |       90 |     72% |146, 157-167, 174-177, 190-192, 239-241, 283-284, 307-314, 322, 324-325, 374-375, 495, 500, 507, 517, 528, 538, 587-588, 740, 746-797, 801-844, 848 |
| src/pdum/rfb/session.py                   |      210 |       15 |     93% |143, 145-146, 187, 317-326, 362, 381 |
| src/pdum/rfb/sources.py                   |       81 |        8 |     90% |102-105, 128-129, 132, 177 |
| src/pdum/rfb/transport.py                 |       16 |        0 |    100% |           |
| src/pdum/rfb/types.py                     |       44 |        0 |    100% |           |
| **TOTAL**                                 | **3050** | **1110** | **64%** |           |


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