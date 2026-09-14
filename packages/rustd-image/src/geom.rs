#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Point {
    pub x: i32,
    pub y: i32,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Rect {
    pub min: Point,
    pub max: Point,
}

impl Point {
    pub fn add(self, p: Point) -> Point {
        Point { x: self.x + p.x, y: self.y + p.y }
    }
    pub fn sub(self, p: Point) -> Point {
        Point { x: self.x - p.x, y: self.y - p.y }
    }
    pub fn eq(self, p: Point) -> bool {
        self == p
    }
    pub fn in_rect(self, r: Rect) -> bool {
        r.min.x <= self.x && self.x < r.max.x && r.min.y <= self.y && self.y < r.max.y
    }
}

impl Rect {
    pub fn new(x0: i32, y0: i32, x1: i32, y1: i32) -> Self {
        Self {
            min: Point { x: x0, y: y0 },
            max: Point { x: x1, y: y1 },
        }
        .canon()
    }

    pub fn zr() -> Self {
        Self {
            min: Point { x: 0, y: 0 },
            max: Point { x: 0, y: 0 },
        }
    }

    pub fn dx(self) -> i32 {
        self.max.x.wrapping_sub(self.min.x)
    }
    pub fn dy(self) -> i32 {
        self.max.y.wrapping_sub(self.min.y)
    }
    pub fn size(self) -> Point {
        Point { x: self.dx(), y: self.dy() }
    }
    pub fn empty(self) -> bool {
        self.min.x >= self.max.x || self.min.y >= self.max.y
    }
    pub fn eq(self, r: Rect) -> bool {
        self.empty() && r.empty() || self == r
    }
    pub fn in_rect(self, r: Rect) -> bool {
        if self.empty() {
            return true;
        }
        r.min.x <= self.min.x && self.max.x <= r.max.x && r.min.y <= self.min.y && self.max.y <= r.max.y
    }
    pub fn overlaps(self, r: Rect) -> bool {
        !self.empty()
            && !r.empty()
            && self.min.x < r.max.x
            && r.min.x < self.max.x
            && self.min.y < r.max.y
            && r.min.y < self.max.y
    }
    pub fn add(self, p: Point) -> Rect {
        Rect {
            min: self.min.add(p),
            max: self.max.add(p),
        }
    }
    pub fn sub(self, p: Point) -> Rect {
        Rect {
            min: self.min.sub(p),
            max: self.max.sub(p),
        }
    }
    pub fn inset(self, n: i32) -> Rect {
        if self.dx() < 2 * n {
            let x = (self.min.x + self.max.x) / 2;
            Rect {
                min: Point { x, y: self.min.y },
                max: Point { x, y: self.max.y },
            }
            .inset_y(n)
        } else if self.dy() < 2 * n {
            let y = (self.min.y + self.max.y) / 2;
            Rect {
                min: Point { x: self.min.x, y },
                max: Point { x: self.max.x, y },
            }
            .inset_x(n)
        } else {
            Rect {
                min: Point { x: self.min.x + n, y: self.min.y + n },
                max: Point { x: self.max.x - n, y: self.max.y - n },
            }
        }
    }
    fn inset_x(self, n: i32) -> Rect {
        if self.dx() < 2 * n {
            let x = (self.min.x + self.max.x) / 2;
            Rect {
                min: Point { x, y: self.min.y },
                max: Point { x, y: self.max.y },
            }
        } else {
            Rect {
                min: Point { x: self.min.x + n, y: self.min.y },
                max: Point { x: self.max.x - n, y: self.max.y },
            }
        }
    }
    fn inset_y(self, n: i32) -> Rect {
        if self.dy() < 2 * n {
            let y = (self.min.y + self.max.y) / 2;
            Rect {
                min: Point { x: self.min.x, y },
                max: Point { x: self.max.x, y },
            }
        } else {
            Rect {
                min: Point { x: self.min.x, y: self.min.y + n },
                max: Point { x: self.max.x, y: self.max.y - n },
            }
        }
    }
    pub fn intersect(self, r: Rect) -> Rect {
        let out = Rect {
            min: Point {
                x: self.min.x.max(r.min.x),
                y: self.min.y.max(r.min.y),
            },
            max: Point {
                x: self.max.x.min(r.max.x),
                y: self.max.y.min(r.max.y),
            },
        };
        if out.min.x >= out.max.x || out.min.y >= out.max.y {
            Rect::zr()
        } else {
            out
        }
    }
    pub fn union(self, r: Rect) -> Rect {
        if self.empty() {
            return r;
        }
        if r.empty() {
            return self;
        }
        Rect {
            min: Point {
                x: self.min.x.min(r.min.x),
                y: self.min.y.min(r.min.y),
            },
            max: Point {
                x: self.max.x.max(r.max.x),
                y: self.max.y.max(r.max.y),
            },
        }
    }
    pub fn canon(self) -> Rect {
        let mut r = self;
        if r.max.x < r.min.x {
            std::mem::swap(&mut r.min.x, &mut r.max.x);
        }
        if r.max.y < r.min.y {
            std::mem::swap(&mut r.min.y, &mut r.max.y);
        }
        r
    }
}
