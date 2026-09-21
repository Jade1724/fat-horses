//! Live check against TAB NZ: print the race F3 would choose now. Not run by `make check`.

use chrono::Utc;
use domain::race::{RaceProvider, candidates};
use fat_horses_race::{Identity, TabNz, tab_nz::DEFAULT_BASE_URL};

#[tokio::main]
async fn main() -> Result<(), Box<dyn std::error::Error>> {
    let tab = TabNz::new(DEFAULT_BASE_URL, Identity::from_env())?;
    let now = Utc::now();
    let schedule = tab.schedule(now).await?;
    println!("{} races scheduled", schedule.len());
    for race in candidates(&schedule, now) {
        let update = tab.update(race).await?;
        if update.race.has_enough_runners() {
            let r = &update.race;
            println!(
                "next: {} R{} {} ({}), starts {}, {:?}, {} runners ({} active)",
                r.venue,
                r.race_number,
                r.name,
                r.venue_country,
                r.start_time,
                r.status,
                r.runners.len(),
                r.active_runners().count()
            );
            return Ok(());
        }
    }
    println!("no eligible race in the next 3 hours");
    Ok(())
}
