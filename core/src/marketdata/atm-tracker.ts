export interface AtmTrackerOptions {
  strikeStepPaise: number;
  hysteresisRatio?: number;
}

export interface AtmUpdate {
  atmStrikePaise: number;
  changed: boolean;
  driftPaise: number;
}

export class AtmTracker {
  private current: number | undefined;
  private readonly strikeStepPaise: number;
  private readonly hysteresisPaise: number;

  constructor(opts: AtmTrackerOptions) {
    this.strikeStepPaise = opts.strikeStepPaise;
    this.hysteresisPaise = Math.max(0, this.strikeStepPaise * (opts.hysteresisRatio ?? 0.6));
  }

  update(spotPaise: number): AtmUpdate {
    const nearest = Math.round(spotPaise / this.strikeStepPaise) * this.strikeStepPaise;
    if (this.current === undefined) {
      this.current = nearest;
      return { atmStrikePaise: nearest, changed: true, driftPaise: spotPaise - nearest };
    }

    const drift = spotPaise - this.current;
    if (Math.abs(drift) >= this.hysteresisPaise && nearest !== this.current) {
      this.current = nearest;
      return { atmStrikePaise: nearest, changed: true, driftPaise: spotPaise - nearest };
    }

    return { atmStrikePaise: this.current, changed: false, driftPaise: drift };
  }

  currentAtm(): number | undefined {
    return this.current;
  }
}
