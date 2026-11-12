---
name: c-style
description: >
  C coding style and conventions. Use before you review or edit C source.
---

# C Style

- Be consistent with the names `len`, `size`, `cap`, `count`
  - len: the length of a sequence (string)
  - size: the size in bytes of an allocation or object (sizeof object)
  - count: the count of a collection of elements (countof(array))
  - cap: the capacity of a buffer or a collection in terms of their elements (bytes buffers can use "size"`
- Avoid declarations after statements: group declarations at the start of a block for readability. A loop counter declared in the for() initializer is a permitted exception.
- Allow empty `//` trailing comments in consecutive lines for alignment
- Name boolean predicates with an `is_` prefix, for example `is_valid_key`. Verb
  idioms such as `starts_with / ends_with`, `contains / includes` are permitted
  exceptions.
- We use the Zig commenting convention with three types of comments:
  1. Normal comments: `// comment`

     ```
     // Calculate the hypotenuse
     c = a*a + b*b;
     c = sqrt(c);
     ```
  2. Doc comments: `/// comment`

     ```
     /// The value of pi
     const float PI = 3.14159;
     ```
  3. Top level comments: `//! comment`

     ```
     #pragma once
     //! This modules defines some stuff

     int frobnicate(int a, int b);
     ```
