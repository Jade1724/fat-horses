//! One pick-workflow step per invocation, called by Step Functions (SPEC.md §6).
//!
//! Input: `{"step": "start" | "prepare_nearby" | "check_result" | "finish", "pick_id": "…"}`.
//! Output: [`app::workflow::StepOutput`]. Environment: `TABLE_NAME`.

use app::workflow::{Deps, Step, StepOutput, run_step};
use domain::countries::CountriesFile;
use fat_horses_lambdas as l;
use lambda_runtime::{Error, LambdaEvent, service_fn};
use rand::SeedableRng;
use rand::rngs::StdRng;
use serde::Deserialize;

#[derive(Deserialize)]
struct Input {
    step: Step,
    pick_id: String,
}

#[tokio::main]
async fn main() -> Result<(), Error> {
    l::init_tracing();
    let config = l::aws_config().await;
    let deps = std::sync::Arc::new(Deps {
        races: l::tab_nz()?,
        places: l::overpass()?,
        classifier: l::classifier(),
        store: l::dynamo_store(&config)?,
        countries: CountriesFile::bundled(),
        config: l::workflow_config(),
    });
    lambda_runtime::run(service_fn(move |event: LambdaEvent<Input>| {
        let deps = deps.clone();
        async move {
            let Input { step, pick_id } = event.payload;
            let span = tracing::info_span!("step", pick_id = %pick_id, step = ?step);
            let _enter = span.enter();
            let mut rng = StdRng::from_rng(&mut rand::rng());
            let out: StepOutput =
                run_step(&deps, step, &pick_id, chrono::Utc::now(), &mut rng).await?;
            tracing::info!(status = ?out.status, decided = out.decided, "step done");
            Ok::<_, Error>(out)
        }
    }))
    .await
}
