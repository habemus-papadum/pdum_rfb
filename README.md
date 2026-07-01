# Repository Coverage

[Full report](https://htmlpreview.github.io/?https://github.com/habemus-papadum/pdum_rfb/blob/python-coverage-comment-action-data/htmlcov/index.html)

| Name                                      |    Stmts |     Miss |   Cover |   Missing |
|------------------------------------------ | -------: | -------: | ------: | --------: |
| src/pdum/rfb/\_\_init\_\_.py              |       30 |        6 |     80% |103-105, 107-109, 111-113 |
| src/pdum/rfb/adaptive.py                  |       50 |        2 |     96% |    85, 88 |
| src/pdum/rfb/asgi.py                      |       71 |        8 |     89% |83-85, 103-107, 113-114 |
| src/pdum/rfb/auth.py                      |       16 |        0 |    100% |           |
| src/pdum/rfb/benchmark.py                 |      283 |      192 |     32% |62, 143-144, 198-216, 244-290, 322-371, 404-448, 464-468, 474-477, 497-502, 506-507, 511-514, 520-650, 654 |
| src/pdum/rfb/cli.py                       |      205 |      102 |     50% |35-37, 70, 87, 91, 106-107, 118-119, 137-138, 152-153, 167-168, 180-181, 189-190, 196, 200, 202, 204, 208, 212-224, 229-242, 259-345, 373-402, 406 |
| src/pdum/rfb/demo\_server.py              |      476 |      107 |     78% |66, 71-72, 86-87, 145-146, 349, 351, 367-368, 375-376, 511, 545-556, 593-596, 602-605, 682, 704, 711-712, 720, 734, 761-764, 783, 797-798, 819-823, 828-844, 849, 856-858, 869-878, 884-921, 941-951, 973, 983, 992 |
| src/pdum/rfb/demos.py                     |      118 |       34 |     71% |107, 109-111, 116-117, 121-127, 130-135, 138-142, 151-154, 176-179, 201-210 |
| src/pdum/rfb/display.py                   |      294 |       36 |     88% |48, 51-52, 65, 72, 75-76, 255-260, 262-269, 277-279, 314-319, 346-348, 440, 461, 464, 489, 493, 532-533, 609 |
| src/pdum/rfb/encoders/\_\_init\_\_.py     |        4 |        0 |    100% |           |
| src/pdum/rfb/encoders/base.py             |       47 |       16 |     66% |47-50, 55-59, 67-70, 77-80, 140-141, 154 |
| src/pdum/rfb/encoders/h264\_cpu.py        |      108 |        7 |     94% |61, 135-137, 142, 206, 221, 226 |
| src/pdum/rfb/encoders/image.py            |       45 |        4 |     91% |31-33, 39, 87 |
| src/pdum/rfb/encoders/nvenc\_cpu.py       |       85 |       39 |     54% |52, 54, 87-88, 106-107, 132-137, 147-175, 185-211 |
| src/pdum/rfb/encoders/nvenc\_gpu\_pdum.py |      134 |      109 |     19% |42-45, 58-61, 87-129, 144-156, 159-173, 179-185, 191-196, 201, 204-210, 213-214, 219, 243-271, 276-301 |
| src/pdum/rfb/encoders/nvenc\_gpu\_pyav.py |       78 |       78 |      0% |    26-176 |
| src/pdum/rfb/encoders/vtenc.py            |      118 |       92 |     22% |34-37, 46-56, 78-97, 100-110, 115-125, 128-137, 146, 152-155, 158-164, 167-168, 173, 195-200, 205-219 |
| src/pdum/rfb/gpu.py                       |      153 |      103 |     33% |93-99, 142-145, 153, 162-164, 175-189, 198-203, 208-209, 228-244, 269-280, 296, 299, 305, 309-313, 316, 319, 332-362, 381-388 |
| src/pdum/rfb/metal.py                     |      103 |       74 |     28% |35-40, 49-51, 79-96, 105-107, 114-118, 138-158, 173-186, 192-202, 210-214, 229, 232, 235, 239, 242, 245 |
| src/pdum/rfb/metrics.py                   |       42 |        0 |    100% |           |
| src/pdum/rfb/notebook.py                  |       39 |        9 |     77% |   101-111 |
| src/pdum/rfb/protocol.py                  |       78 |        2 |     97% |   67, 171 |
| src/pdum/rfb/rendercanvas.py              |       61 |        3 |     95% |131, 152, 188 |
| src/pdum/rfb/server.py                    |      326 |       93 |     71% |146, 157-167, 174-177, 190-192, 239-241, 292-293, 317-324, 384-385, 509, 526, 533, 543, 554, 564, 613-614, 775, 781-844, 848-910, 914 |
| src/pdum/rfb/session.py                   |      232 |       15 |     94% |166, 168-169, 210, 359-368, 404, 423 |
| src/pdum/rfb/sources.py                   |       81 |        8 |     90% |102-105, 128-129, 132, 177 |
| src/pdum/rfb/transport.py                 |       16 |        0 |    100% |           |
| src/pdum/rfb/types.py                     |       62 |        0 |    100% |           |
| **TOTAL**                                 | **3355** | **1139** | **66%** |           |


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