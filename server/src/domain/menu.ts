// Reading a menu photo into dish names (SPEC.md F15, §3). The reader only
// transcribes: it never chooses dishes; the race does.

export type MenuImageType = "image/jpeg" | "image/png" | "image/webp";

export interface MenuImage {
  media_type: MenuImageType;
  /** Base64, no data: prefix. */
  data: string;
}

export interface MenuReading {
  restaurant_name: string | null;
  /** As read; the caller tidies them (`dishesFromReading`). */
  dishes: string[];
}

export interface MenuReader {
  read(image: MenuImage): Promise<MenuReading>;
}

/** The reader couldn't produce a reading (model error, refusal, timeout). */
export class MenuUnreadable extends Error {}

/** No model is configured, so no photo can be read (MENU_MODEL_ID unset). */
export class MenuReadingNotSetUp extends MenuUnreadable {}

/** A fixed answer, for tests and running without Bedrock (`MENU_READER=fake`). */
export class FakeMenuReader implements MenuReader {
  reads = 0;

  constructor(private readonly answer: MenuReading | Error = SAMPLE_MENU) {}

  async read(): Promise<MenuReading> {
    this.reads++;
    if (this.answer instanceof Error) throw this.answer;
    return { ...this.answer, dishes: [...this.answer.dishes] };
  }
}

export const SAMPLE_MENU: MenuReading = {
  restaurant_name: "Sample Thai",
  dishes: [
    "Pad Thai",
    "Green curry",
    "Chicken satay",
    "Tom yum soup",
    "Larb gai",
    "Massaman beef",
    "Mango sticky rice",
  ],
};
