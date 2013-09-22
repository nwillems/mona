"use strict";

/*
 * API
 */

/**
 * Executes a parser and returns the result.
 *
 * @param {Function} parser - The parser to execute.
 * @param {String} string - String to parse.
 * @param {Object} [opts] - Options object.
 * @param {Boolean} [opts.throwOnError=true] - If truthy, throws a ParseError if
 *                                             the parser fails.
 * @param {String} [opts.fileName] - filename to use for error messages.
 * @returns {value|ParseError}
 */
function parse(parser, string, opts) {
  opts = opts || {
    throwOnError: true
  };
  var parseState = parser(
    new ParserState(undefined, string, opts.userState,
                    new SourcePosition(opts.fileName), false));
  if (parseState.error && opts.throwOnError) {
    throw parseState.error;
  } else if (parseState.error && !opts.throwOnError) {
    return parseState.error;
  } else {
    return parseState.value;
  }
}

/*
 * Core parsers
 */

/**
 * A function accepting parserState as input that transforms it and returns a
 * new parserState.
 * @callback {Function} Parser
 * @param {ParserState} state - Current parser state.
 * @returns {ParserState} state' - Transformed parser state.
 */

/**
 * Returns a parser that always succeeds without consuming input.
 *
 * @param [val=undefined] - value to use as this parser's value.
 * @returns {Parser}
 */
function value(val) {
  return function(parserState) {
    return attr(parserState, "value", val);
  };
}

/**
 * Returns a parser that calls `fun` on the value resulting from running
 * `parser` on the current parsing state. Fails without executing `fun` if
 * `parser` fails.
 *
 * @param {Parser} parser - The parser to execute.
 * @param {Function} fun - Function called with the resulting value of
 *                         `parser`. Must return a parser.
 * @returns {Parser}
 */
function bind(parser, fun) {
  return function(parserState) {
    var newParserState = parser(parserState);
    return fun(newParserState.value)(newParserState);
  };
}

/**
 * Returns a parser that always fails without consuming input. Automatically
 * includes the line and column positions in the final ParseError.
 *
 * @param {String} msg - Message to report with the failure.
 * @param {String} type - A type to apply to the ParseError.
 * @returns {Parser}
 */
function fail(msg, type) {
  msg = msg || "parser error";
  type = type || "failure";
  return function(parserState) {
    return attr(parserState, "error", function(oldErr) {
      return mergeErrors(
        oldErr, new ParseError(parserState.position, [msg], type));
    });
  };
}

/**
 * Returns a parser that consumes a single item from the input, or fails with an
 * unexpected eof error if there is no input left.
 *
 * @returns {Parser}
 */
function token() {
  return function(parserState) {
    var input = parserState.restOfInput;
    if (input.length) {
      var newParserState = copy(parserState),
          newPosition = copy(parserState.position);
      if (input[0] === "\n") {
        newPosition.column = 1;
        newPosition.line += 1;
      } else {
        newPosition.column += 1;
      }
      newParserState.value = input[0];
      newParserState.restOfInput = input.slice(1);
      newParserState.position = newPosition;
      return newParserState;
    } else {
      return fail("unexpected eof", "eof")(parserState);
    }
  };
}

/**
 * Returns a parser that succeeds with a value of `true` if there is no more
 * input to consume.
 *
 * @returns {Parser}
 */
function eof() {
  return function(parserState) {
    if (!parserState.restOfInput) {
      return attr(parserState, "value", true);
    } else {
      return fail("expected an eof", "expectation");
    }
  };
}

/*
 * Combinators
 *
 */

/**
 * Returns a parser that succeeds if all the parsers given to it succeed. The
 * returned parser uses the value of the last successful parser.
 *
 * @param {...Parser} parsers - One or more parsers to execute.
 * @returns {Parser}
 */
function and(firstParser) {
  var moreParsers = [].slice.call(arguments, 1);
  return bind(firstParser, function(result) {
    return moreParsers.length ?
      and.apply(null, moreParsers) :
      value(result);
  });
}

/**
 * Returns a parser that succeeds if one of the parsers given to it
 * suceeds. Uses the value of the first successful parser.
 *
 * @param {...Parser} parsers - One or more parsers to execute.
 * @returns {Parser}
 */
function or() {
  function orHelper() {
    var parsers = [].slice.call(arguments);
    return function(parserState) {
      var res = parsers[0](parserState);
      if (res.error && parsers[1]) {
        return orHelper.apply(null, parsers.slice(1))(parserState);
      } else {
        return res;
      }
    };
  }
  return orHelper.apply(null, arguments);
}

/**
 * Returns a parser that returns the result of `parser` if it succeeds,
 * otherwise succeeds with a value of `undefined` without consuming input.
 *
 * @param {Parser} parser - Parser to try.
 * @returns {Parser}
 */
function maybe(parser) {
  return or(parser, value());
}

/**
 * Returns a parser that succeeds if `parser` fails. Does not consume.
 *
 * @param {Parser} parser - parser to test.
 * @returns {Parser}
 */
function not(parser) {
  return function(parserState) {
    return parser(parserState).error ?
      value(true)(parserState) :
      fail("expected parser to fail")(parserState);
  };
}

/**
 * Returns a parser that works like `and`, but fails if the first parser given
 * to it succeeds. Like `and`, it returns the value of the last successful
 * parser.
 *
 * @param {Parser} notParser - If this parser succeeds, `unless` will fail.
 * @param {...Parser} moreParsers - Rest of the parses to test.
 * @returns {Parser}
 */
function unless(parser) {
  var moreParsers = [].slice.call(arguments, 1);
  return and.apply(null, [not(parser)].concat(moreParsers));
}

/**
 * Returns a parser that will execute `fun` while handling the parserState
 * internally, allowing the body of `fun` to be written sequentially. The
 * purpose of this parser is to simulate `do` notation and prevent the need for
 * heavily-nested `bind` calls.
 *
 * The `fun` callback will receive a function `s` which should be called with
 * each parser that will be executed, which will update the internal parseState.
 *
 * If any of the parsers fail, the entire sequence will fail with that parser's
 * reason.
 *
 * @param {Function} fun - A sequence callback to execute.
 * @returns {Parser}
 *
 * @example
 * mona.sequence(function(s) {
 *  var x = s(mona.token());
 *  var y = s(mona.character('b'));
 *  return mona.value(x+y);
 * });
 */
function sequence(fun) {
  return function(parserState) {
    var state = parserState, failwhale = {};
    function s(parser) {
      state = parser(state);
      if (state.error) {
        throw failwhale;
      } else {
        return state.value;
      }
    }
    try {
      return fun(s)(state);
    } catch(x) {
      if (x === failwhale) {
        return state;
      } else {
        throw x;
      }
    }
  };
}

/**
 * Returns a parser that returns the result of its first parser if it succeeds,
 * but fails if any of the following parsers fail.
 *
 * @param {Parser} parser - The value of this parser is returned if it succeeds.
 * @param {...Parser} moreParsers - These parsers must succeed in order for
 *                                  `followedBy` to succeed.
 * @returns {Parser}
 */
function followedBy(parser) {
  var parsers = [].slice.call(arguments, 1);
  return bind(parser, function(result) {
    return bind(and.apply(null, parsers), function() {
      return value(result);
    });
  });
}

/**
 * Returns a parser that returns an array of results that have been successfully
 * parsed by `parser`, which were separated by `separator`.
 *
 * @param {Parser} parser - Parser for matching and collecting results.
 * @param {Parser} separator - Parser for the separator
 * @returns {Parser}
 */
function separatedBy(parser, separator) {
  return sequence(function(s) {
    var x = s(parser);
    var xs = s(zeroOrMore(and(separator, parser)));
    return mona.value([x].concat(xs));
  });
}

/**
 * Returns a parser that results in an array of zero or more successful parse
 * results for `parser`.
 *
 * @param {Parser} parser - The parser to try to apply.
 * @returns {Parser}
 */
function zeroOrMore(parser) {
  return function(parserState) {
    var prev = parserState, s = parserState, res =[];
    while (s = parser(s), !s.error) {
      res.push(s.value);
      prev = s;
    }
    return value(res)(prev);
  };
}

/**
 * Returns a parser that results in an array of zero or more successful parse
 * results for `parser`. The parser must succeed at least once.
 *
 * @param {Parser} parser - The parser to collect results for.
 * @returns {Parser}
 */
function oneOrMore(parser) {
  return sequence(function(s) {
    var x = s(parser),
        y = s(zeroOrMore(parser));
    return value([x].concat(y));
  });
}

/*
 * Strings
 */

/**
 * Returns a parser that succeeds if the next token satisfies `predicate`,
 * returning the accepted character as its value. Fails if `predicate` does not
 * match.
 *
 * @param {Function} predicate - Called with a single token. Should return a
 *                               truthy value if the token should be accepted.
 * @returns {Parser}
 */
function satisfies(predicate) {
  return bind(token(), function(c) {
    if (predicate(c)) {
      return value(c);
    } else {
      return fail("token does not match predicate");
    }
  });
}

/**
 * Returns a string containing the concatenated results returned by applying
 * `parser`. `parser` must be a combinator that returns an array of string parse
 * results.
 *
 * @param {Parser} parser - Parser that results in an array of strings.
 * @returns {Parser}
 */
function stringOf(parser) {
  return bind(parser, function(xs) { return value(xs.join("")); });
}

/**
 * Returns a parser that tries to consume and return a single character matching
 * `x`.
 *
 * @param {String} x - A single-character string to match against the next token.
 * @returns {Parser}
 */
function character(x) {
  return satisfies(function(y) {
    return x === y;
  });
}

/**
 * Returns a parser that succeeds if the next token is one of the provided
 * `chars`.
 *
 * @param {String|Array|Array-like} chars - Character bag to match the next
 *                                          token against.
 * @returns {Parser}
 */
function oneOf(chars) {
  return satisfies(function(x) { return ~chars.indexOf(x); });
}

/**
 * Returns a parser that fails if the next token matches any of the provided
 * `chars`.
 *
 * @param {String|Array|Array-like} chars - Character bag to match against.
 * @returns {Parser}
 */
function noneOf(chars) {
  return satisfies(function(x) { return !~chars.indexOf(x); });
}

/**
 * Returns a parser that succeeds if `str` matches the next `str.length` inputs,
 * consuming the string and returning it as a value.
 *
 * @param {String} str - String to match against.
 * @returns {Parser}
 */
function string(str) {
  return !str.length ?
    value("") :
    sequence(function(s) {
      s(character(str[0]));
      s(string(str.substr(1)));
      return value(str);
    });
}

/**
 * Returns a parser that parses a single digit character token from the input.
 *
 * @param {integer} [base=10] - Optional base for the digit.
 * @returns {Parser}
 */
function digitCharacter(base) {
  base = base || 10;
  return satisfies(function(x) { return !isNaN(parseInt(x, base)); });
}

/**
 * Returns a parser that matches one whitespace character.
 *
 * @returns {Parser}
 */
function space() {
  return oneOf(" \t\n\r");
}

/**
 * Returns a parser that matches one or more whitespace characters. Returns a
 * single space character as its result, regardless of which whitespace
 * characters were matched.
 *
 * @returns {Parser}
 */
function spaces() {
  return and(oneOrMore(space()), value(" "));
}

/**
 * Returns a parser that collects one or more tokens matching `parser`. The
 * result is returned as a single string.
 *
 * @param {Parser} [parser=token()] - Parser to use to collect the results.
 */
function text(parser) {
  parser = parser || token();
  return stringOf(oneOrMore(parser));
}

/*
 * Numbers
 */

/**
 * Returns a parser that matches a single digit from the input, returning the
 * number represented by that digit as its value.
 *
 * @param {integer} [base=10] - Base to use when parsing the digit.
 */
function digit(base) {
  base = base || 10;
  return sequence(function(s) {
    var c = s(token()),
        digit = s(value(parseInt(c, base)));
    return isNaN(digit) ? fail("invalid digit") : value(digit);
  });
}

/**
 * Returns a parser that matches a natural number. That is, a number without a
 * positive/negative sign or decimal places, and returns a positive integer.
 *
 * @param {integer} [base=10] - Base to use when parsing the number.
 */
function naturalNumber(base) {
  base = base || 10;
  return sequence(function(s) {
    var xs = s(oneOrMore(digitCharacter(base)));
    return value(parseInt(xs.join(""), base));
  });
}

/**
 * Returns a parser that matches an integer, with an optional + or - sign.
 *
 * @param {integer} [base=10] - Base to use when parsing the integer.
 */
function integer(base) {
  base = base || 10;
  return sequence(function(s) {
    var sign = s(maybe(or(character("+"),
                          character("-")))),
        num = s(naturalNumber(base));
    return value(num * (sign === "-" ? -1 : 1));
  });
}

var mona = module.exports = {
  // API
  parse: parse,
  // Base parsers
  value: value,
  bind: bind,
  fail: fail,
  token: token,
  eof: eof,
  // Combinators
  and: and,
  or: or,
  maybe: maybe,
  not: not,
  unless: unless,
  sequence: sequence,
  followedBy: followedBy,
  separatedBy: separatedBy,
  zeroOrMore: zeroOrMore,
  oneOrMore: oneOrMore,
  // String-related parsers
  satisfies: satisfies,
  stringOf: stringOf,
  character: character,
  oneOf: oneOf,
  noneOf: noneOf,
  string: string,
  digitCharacter: digitCharacter,
  space: space,
  spaces: spaces,
  text: text,
  // Numbers
  digit: digit,
  naturalNumber: naturalNumber,
  integer: integer
};

/*
 * Internals
 */
function copy(obj) {
  var newObj = Object.create(Object.getPrototypeOf(obj));
  for (var key in obj) {
    if (obj.hasOwnProperty(key)) {
      newObj[key] = obj[key];
    }
  }
  return newObj;
}

function attr(obj, name, arg) {
  if (arguments.length < 2) {
    return copy(obj);
  } else if (arguments.length < 3) {
    return obj[name];
  } else {
    var newObj = copy(obj);
    newObj[name] = (typeof arg === "function") ?
      arg(obj[name]) :
      arg;
    return newObj;
  }
}

/**
 * Represents a source location.
 * @typedef {Object} SourcePosition
 * @property {String} name - Optional sourcefile name.
 * @property {integer} line - Line number, starting from 1.
 * @property {integer} column - Column number in the line, starting from 1.
 */
function SourcePosition(name, line, column) {
  this.name = name;
  this.line = line || 1;
  this.column = column || 1;
}

/**
 * Information about a parsing failure.
 * @typedef {Object} ParseError
 * @property {SourcePosition} position - Source position for the error.
 * @property {Array} messages - Array containing relevant error messages.
 * @property {String} type - The type of parsing error.
 */
function ParseError(pos, messages, type) {
  this.position = pos;
  this.messages = messages;
  this.type = type;
}

function mergeErrors(err1, err2) {
  if (!err1 || (!err1.messages.length && err2.messages.length)) {
    return err2;
  } else if (!err2 || (!err2.messages.length && err1.messages.length)) {
    return err1;
  } else {
    return new ParseError(err1.pos, err1.messages.concat(err2.messages));
  }
}

function ParserState(value, restOfInput, userState,
                     position, hasConsumed, error) {
  this.value = value;
  this.restOfInput = restOfInput;
  this.position = position;
  this.userState = userState;
  this.error = error;
}