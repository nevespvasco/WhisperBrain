'use strict';
const STOP = new Set('the a an and or of to in on for with is are was were be been it this that these those at by from as i you we they he she what who when where why how did do does about can could should would will not no yes me my our your their there here have has had say said tell'.split(' '));
const words = (t) => (String(t).toLowerCase().match(/[\p{L}\p{N}]+/gu) || []).filter((w) => w.length > 1 && !STOP.has(w));
module.exports = { STOP, words };
