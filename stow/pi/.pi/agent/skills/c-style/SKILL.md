---
name: c-style
description: >
  C coding style and conventions. Use before you review or edit C source.
---

# C Style

- Prefer Rust-Style docstrings when placed above a definition (`/// Some
  documentation`) or when documenting modules (`//! Module documentation`). Use
  simple C++-Style comments (`// Some comment`) for inline documentation behind
  the definition.
- Delimit a major source section with a two-line banner: a full-width rule of
  `/` characters, then the section title on a `/// Title` line. For example:
  ```
  ///////////////////////////////////////////////////////////////////////////////
  /// SHA-256
  ```
- When you declare a function that takes buffer arguments, prefer the VLA style
  notation, for example `foo(usize size, char buf[size])`, which places the size
  parameter before the buffer parameter.
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
